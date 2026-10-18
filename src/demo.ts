/**
 * 最小演示：写几条事件，按轮投影成记忆 log 行。
 * 不写记忆库（profile.memoryLogRoot 没配），只打印。
 *
 * @module if/demo
 */

import { registerCoreEvents } from './core/registry.ts'
import { EventStore } from './core/store.ts'
import { sessionStream } from './core/streams.ts'
import { defaultProfile } from './config/profile.ts'
import { projectEvents } from './projections/archiver.ts'
import { memoryLogProjection } from './projections/memory-log.ts'
import { userTurnPolicy } from './turn/policy.ts'

registerCoreEvents()

const profile = {
  ...defaultProfile(),
  principals: {
    user: { id: 'u-1', name: '示例用户' },
    agents: [{ id: 'a-1', name: '示例助手', role: 'main' }],
  },
}

const sessionId = 'demo-2'
const store = new EventStore(`${profile.dataRoot}/sessions/${sessionId}.jsonl`)
const stream = sessionStream(sessionId)

store.append({
  stream, actor: 'system', type: 'session.created',
  payload: { cwd: process.cwd(), principals: profile.principals },
})

store.append({
  stream, actor: 'user', actorId: 'u-1', type: 'message.user',
  payload: { text: '你好' },
})

store.append({
  stream, actor: 'agent', actorId: 'a-1', type: 'thoughts.segment',
  payload: { seq: 1, text: '先确认目录' },
})

store.append({
  stream, actor: 'agent', actorId: 'a-1', type: 'tool.call',
  payload: { call: 'Read', hint: 'events.md', args: { file_path: 'events.md' } },
})

store.append({
  stream, actor: 'tool', actorId: 't-1', type: 'tool.result',
  payload: { callId: 'c-1', text: 'ok' },
})

store.append({
  stream, actor: 'agent', actorId: 'a-1', type: 'message.assistant',
  payload: { text: '我在' },
})

store.append({
  stream, actor: 'system', type: 'token.recorded',
  payload: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0 },
})

const result = projectEvents(store.read(), profile, [memoryLogProjection], userTurnPolicy, sessionId, 0)

console.log('turns:', result.turn, 'lines:', result.lines.length)
for (const line of result.lines) console.log(JSON.stringify(line))
