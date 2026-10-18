/**
 * 会话历史投影的最小验证：正常工具往返 + 一个悬空调用。
 *
 * @module if/projections/history-demo
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { projectHistory } from './history.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-history-'))
const store = new EventStore(join(dir, 'session.jsonl'))
const stream = sessionStream('h1')

const append = (
  actor: string,
  type: string,
  payload: Record<string, unknown>,
  actorId?: string,
): void => {
  store.append({ stream, actor, actorId, type, payload })
}

append('system', 'session.created', { cwd: process.cwd() })
append('user', 'message.user', { text: '你好' }, 'u1')
append('agent', 'thoughts.segment', { seq: 1, text: '先看看' }, 'a1')
append('agent', 'message.assistant', { text: '我在' }, 'a1')
append('agent', 'tool.call', { callId: 'c1', call: 'Read', args: { file_path: 'events.md' } }, 'a1')
append('tool', 'tool.result', { callId: 'c1', text: 'ok' }, 't1')
append('agent', 'message.assistant', { text: '读完了' }, 'a1')
append('user', 'message.user', { text: '再来' }, 'u1')
append('agent', 'tool.call', { callId: 'c2', call: 'Bash', args: { command: 'sleep 1' } }, 'a1')
append('agent', 'message.assistant', { text: '等你' }, 'a1')

const messages = projectHistory(store.read())
console.log(JSON.stringify(messages, null, 2))
