/**
 * 真实模型子 agent：读 events.md，写一份报告。
 *
 * @module if/agents/live
 */

import { join } from 'node:path'
import { defaultProfile } from '../config/profile.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { registerProvider } from '../model/registry.ts'
import { InMemoryApprovalRegistry } from '../tools/approval.ts'
import { readTool } from '../tools/builtin/read.ts'
import { writeTool } from '../tools/builtin/write.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { AgentManager } from './manager.ts'
import { PresetRegistry } from './presets.ts'
import { runSubagent } from './run.ts'
import type { AgentResult } from './types.ts'

registerCoreEvents()

registerProvider({
  id: 'gateway',
  name: 'Local Gateway',
  defaultChatEndpoint: 'openai-chat-completions',
  endpoints: {
    'openai-chat-completions': {
      adapterFamily: 'openai',
      baseUrl: 'http://127.0.0.1:8765/v1',
    },
  },
  models: [
    { id: 'ex', capabilities: ['function-call'], contextWindow: 1000000 },
    { id: 'normal', capabilities: ['function-call'], contextWindow: 200000 },
  ],
  apiKey: 'sk-any',
})

const presets = new PresetRegistry()
presets.register({
  id: 'researcher',
  description: '读文件、整理事实、写报告。',
  models: [
    { provider: 'gateway', model: 'ex' },
    { provider: 'gateway', model: 'normal' },
  ],
  tools: ['read', 'write'],
  maxSteps: 8,
  timeoutMs: 120_000,
  readOnly: false,
  allowDangerousTools: true,
  systemPrompt: '你是子 agent。先读文件，再写报告；完成后说明路径。',
})

const profile = {
  ...defaultProfile(),
  principals: {
    user: { id: 'u1', name: 'Demo User' },
    agents: [{ id: 'a1', name: 'Demo Agent', role: 'main' }],
  },
}

const tools = new ToolRegistry()
tools.register(readTool)
tools.register(writeTool)

const approvals = new InMemoryApprovalRegistry()
const dir = join(process.cwd(), 'data', 'agents-live')
const storeFactory = (id: string): EventStore => new EventStore(join(dir, `${id}.jsonl`))
const sessionStore = new EventStore(join(dir, 'session.jsonl'))

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
      payload: { text: `子任务 ${result.id}（${result.preset}）${result.status}：${result.summary}` },
    })
  },
  config: { maxConcurrent: 2, queueLimit: 5 },
})

const request = manager.submit({
  preset: 'researcher',
  prompt:
    '读 events.md，把里面的所有事件类型整理成 Markdown 表格，'
    + '写到 data/agent-report.md。最后告诉我报告路径和行数。',
  acceptance: [
    '报告包含 events.md 里的全部事件类型',
    '文件已写入 data/agent-report.md',
    '最后一条回复说明路径',
  ],
  priority: 'normal',
  source: { session: 'live-s1' },
}, presets.get('researcher')!)

console.log('accepted:', request.id)

const started = Date.now()
while (true) {
  const status = manager.status(request.id)
  if (status !== undefined && typeof status !== 'string') break
  if (Date.now() - started > 130_000) throw new Error('live wait timeout')
  await new Promise(resolve => setTimeout(resolve, 500))
}

const result = manager.status(request.id) as AgentResult
console.log('status:', result.status, 'steps:', result.steps)
console.log('usage:', JSON.stringify(result.usage))
console.log('summary:', result.summary)
console.log('artifacts:', JSON.stringify(result.artifacts))
console.log('events:', storeFactory(request.id).read().map(event => event.type).join(' → '))
console.log('delivered:', sessionStore.read().filter(event => event.type === 'message.system').length)
