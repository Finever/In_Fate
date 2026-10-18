/**
 * 对话循环验证：mock 模型第一轮调 read，第二轮给文本。
 * 检查事件顺序、工具结果回填、usage、turn.completed。
 *
 * @module if/loop/demo
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProfile } from '../config/profile.ts'
import { staticSection, timeSection } from '../context/sections.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { registerProvider, resolveModel } from '../model/registry.ts'
import { projectHistory } from '../projections/history.ts'
import { InMemoryApprovalRegistry } from '../tools/approval.ts'
import { readTool } from '../tools/builtin/read.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { runTurn } from './run.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-loop-'))
const filePath = join(dir, 'a.md').replace(/\\/g, '/')
writeFileSync(filePath, 'hello from loop\n', 'utf8')

const toolArguments = JSON.stringify({ file_path: filePath })

function sseToolCall(): string {
  const delta = {
    tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: toolArguments } }],
  }
  return [
    `data: ${JSON.stringify({ choices: [{ delta }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n'
}

function sseText(): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '读完了' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } })}`,
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

const profile = {
  ...defaultProfile(),
  principals: {
    user: { id: 'u1', name: '触久' },
    agents: [{ id: 'a1', name: '未凉', role: 'main' }],
  },
}

const tools = new ToolRegistry()
tools.register(readTool)

const store = new EventStore(join(dir, 'session.jsonl'))
const approvals = new InMemoryApprovalRegistry()

const result = await runTurn('读一下 a.md', {
  store,
  sessionId: 's1',
  profile,
  model: resolveModel('mock', 'mock-model'),
  tools,
  approvals,
  sections: [staticSection('header', '你是示例助手。'), timeSection()],
  cwd: dir,
  now: () => new Date('2026-10-18T12:00:00Z'),
})

console.log('result:', JSON.stringify(result))
console.log('events:', store.read().map(event => event.type).join(' → '))
console.log('history:', projectHistory(store.read()).length, 'messages')

server.close()
