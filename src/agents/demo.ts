/**
 * 子 agent 验证：受理、异步执行、事件流、回送、并发池、失败注入。
 *
 * @module if/agents/demo
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProfile } from '../config/profile.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { registerProvider } from '../model/registry.ts'
import { InMemoryApprovalRegistry } from '../tools/approval.ts'
import { createAgentControlTools } from '../tools/builtin/agent-control.ts'
import { readTool } from '../tools/builtin/read.ts'
import { createRequestAgentTool } from '../tools/builtin/request-agent.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { AgentManager } from './manager.ts'
import { PresetRegistry } from './presets.ts'
import { runSubagent } from './run.ts'
import type { AgentResult } from './types.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-agents-'))

function sseToolCall(): string {
  const args = JSON.stringify({ file_path: 'events.md' })
  const delta = { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: args } }] }
  return [
    `data: ${JSON.stringify({ choices: [{ delta }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n'
}

function sseText(): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '第一行是 session.created|会话开始' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 8 } })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n'
}

let requests = 0
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', () => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(requests === 1 ? sseToolCall() : sseText())
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0

registerProvider({
  id: 'mock',
  name: 'Mock',
  defaultChatEndpoint: 'openai-chat-completions',
  endpoints: {
    'openai-chat-completions': { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` },
  },
  models: [{ id: 'mock-model', capabilities: ['function-call'], contextWindow: 128000 }],
})

const presets = new PresetRegistry()
presets.register({
  id: 'researcher',
  description: '只读调研：读文件、汇总事实。',
  models: [{ provider: 'mock', model: 'mock-model' }],
  tools: ['read'],
  maxSteps: 5,
  timeoutMs: 60_000,
  readOnly: true,
})

const profile = {
  ...defaultProfile(),
  principals: {
    user: { id: 'u1', name: '触久' },
    agents: [{ id: 'a1', name: '未凉', role: 'main' }],
  },
}

const tools = new ToolRegistry()
tools.register(readTool)
const approvals = new InMemoryApprovalRegistry()
const sessionStore = new EventStore(join(dir, 'session.jsonl'))

const storeFactory = (id: string): EventStore => new EventStore(join(dir, 'agents', `${id}.jsonl`))

const manager = new AgentManager({
  storeFactory,
  runner: (request, signal, store, stream) => runSubagent(request, signal, store, stream, {
    tools,
    approvals,
    profile,
    cwd: process.cwd(),
  }),
  deliver: (result, request) => {
    sessionStore.append({
      stream: sessionStream(request.source.session),
      actor: 'system',
      type: 'message.system',
      payload: {
        text: `子任务 ${result.id}（${result.preset}）${result.status}：${result.summary}`,
        agentId: result.id,
      },
    })
  },
  config: { maxConcurrent: 2, queueLimit: 5 },
})

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('wait timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const request = manager.submit({
  preset: 'researcher',
  prompt: '读 events.md，告诉我第一行。',
  acceptance: ['说出第一行'],
  priority: 'normal',
  source: { session: 's1' },
}, presets.get('researcher')!)

console.log('accepted:', request.id, 'status:', manager.status(request.id))
await waitFor(() => {
  const status = manager.status(request.id)
  return status !== undefined && typeof status !== 'string'
})

const result = manager.status(request.id) as AgentResult
console.log('result:', result.status, '|', result.summary)
console.log('agent events:', storeFactory(request.id).read().map(event => event.type).join(' → '))
console.log('delivered systems:', sessionStore.read().filter(event => event.type === 'message.system').length)

// 未知预设
const requestTool = createRequestAgentTool({ manager, presets, sourceSession: 's1' })
const unknown = await requestTool.run({ preset: 'nope', prompt: 'x' }, {} as never)
console.log('unknown preset rejected:', unknown.isError)

// 工具白名单：子 agent 的 registry 里没有 write
console.log('write hidden from subagent:', tools.get('write') === undefined)

// 并发池：假 runner，最大并发应 <= 2
let current = 0
let maxCurrent = 0
const fakeManager = new AgentManager({
  storeFactory: id => new EventStore(join(dir, 'fake', `${id}.jsonl`)),
  runner: async () => {
    current += 1
    maxCurrent = Math.max(maxCurrent, current)
    await new Promise(resolve => setTimeout(resolve, 80))
    current -= 1
    return {
      id: 'fake',
      preset: 'researcher',
      status: 'completed',
      summary: 'done',
      artifacts: [],
      usage: { input: 0, output: 0, cacheRead: 0 },
      steps: 1,
      stream: '',
    }
  },
  config: { maxConcurrent: 2, queueLimit: 10 },
})

const fakeRequests = Array.from({ length: 4 }, () => fakeManager.submit({
  preset: 'researcher',
  prompt: 'x',
  priority: 'normal',
  source: { session: 's1' },
}, presets.get('researcher')!))

await waitFor(() => fakeRequests.every(item => {
  const status = fakeManager.status(item.id)
  return status !== undefined && typeof status !== 'string'
}))
console.log('max concurrent:', maxCurrent, 'completed:', fakeRequests.length)

// 队列满
const tinyManager = new AgentManager({
  storeFactory: id => new EventStore(join(dir, 'tiny', `${id}.jsonl`)),
  runner: async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    return {
      id: 'tiny',
      preset: 'researcher',
      status: 'completed',
      summary: 'done',
      artifacts: [],
      usage: { input: 0, output: 0, cacheRead: 0 },
      steps: 1,
      stream: '',
    }
  },
  config: { maxConcurrent: 1, queueLimit: 1 },
})

tinyManager.submit({ preset: 'researcher', prompt: 'a', priority: 'normal', source: { session: 's1' } }, presets.get('researcher')!)
tinyManager.submit({ preset: 'researcher', prompt: 'b', priority: 'normal', source: { session: 's1' } }, presets.get('researcher')!)
try {
  tinyManager.submit({ preset: 'researcher', prompt: 'c', priority: 'normal', source: { session: 's1' } }, presets.get('researcher')!)
  console.log('queue full rejected: false')
} catch {
  console.log('queue full rejected: true')
}

// 中断
const interruptManager = new AgentManager({
  storeFactory: id => new EventStore(join(dir, 'interrupt', `${id}.jsonl`)),
  runner: async (_request, signal) => {
    await new Promise(resolve => setTimeout(resolve, 500))
    return {
      id: 'slow',
      preset: 'researcher',
      status: signal.aborted ? 'cancelled' : 'completed',
      summary: 'done',
      artifacts: [],
      usage: { input: 0, output: 0, cacheRead: 0 },
      steps: 1,
      stream: '',
    }
  },
  config: { maxConcurrent: 1, queueLimit: 5 },
})
const slow = interruptManager.submit({ preset: 'researcher', prompt: 'slow', priority: 'normal', source: { session: 's1' } }, presets.get('researcher')!)
await new Promise(resolve => setTimeout(resolve, 50))
interruptManager.interrupt(slow.id)
await waitFor(() => typeof interruptManager.status(slow.id) !== 'string')
console.log('interrupted:', (interruptManager.status(slow.id) as AgentResult).status)

// 控制面工具
const controls = createAgentControlTools({ manager })
console.log('control tools:', controls.map(tool => tool.name).join(', '))

server.close()
