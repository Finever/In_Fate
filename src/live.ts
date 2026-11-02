/**
 * 真实网关联调：普通对话 + 工具调用两轮。
 *
 * 用法：node src/live.ts [ex|normal|vision]
 *
 * @module if/live
 */

import { defaultProfile } from './config/profile.ts'
import { staticSection, timeSection } from './context/sections.ts'
import { registerCoreEvents } from './core/registry.ts'
import { EventStore } from './core/store.ts'
import { runTurn } from './loop/run.ts'
import { registerProvider, resolveModel } from './model/registry.ts'
import { projectHistory } from './projections/history.ts'
import { InMemoryApprovalRegistry } from './tools/approval.ts'
import { readTool } from './tools/builtin/read.ts'
import { ToolRegistry } from './tools/registry.ts'

registerCoreEvents()

const modelId = process.argv[2] ?? 'ex'
const sessionId = process.argv[3] ?? `live-${modelId}`

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
  models: [{ id: modelId, capabilities: ['function-call'], contextWindow: 1000000 }],
  apiKey: 'sk-any',
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

const store = new EventStore(`./data/live/${sessionId}.jsonl`)
const base = {
  store,
  sessionId,
  profile,
  model: resolveModel('gateway', modelId),
  tools,
  approvals: new InMemoryApprovalRegistry(),
  sections: [
    staticSection(
      'header',
      '你是Demo Agent，说话精简。消息开头的 [YYYY-MM-DD HH:mm] 是系统注入的时间标签，不是消息内容；回复时不要复制时间标签。',
    ),
    timeSection(),
  ],
  cwd: process.cwd(),
}

console.log(`--- ${modelId} / 普通对话 ---`)
const first = await runTurn('你好，用一句话介绍你自己。', base)
console.log('result:', JSON.stringify(first))

console.log(`--- ${modelId} / 工具调用 ---`)
const second = await runTurn('读一下 events.md，告诉我第一行是什么。', base)
console.log('result:', JSON.stringify(second))

console.log('events:', store.read().map(event => event.type).join(' → '))
const assistants = projectHistory(store.read()).filter(message => message.role === 'assistant')
console.log('last assistant:', JSON.stringify(assistants.at(-1)))
