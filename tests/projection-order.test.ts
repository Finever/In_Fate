import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../src/core/events.ts'
import { projectHistory } from '../src/projections/history.ts'

function event(id: string, type: string, payload: Record<string, unknown> = {}): Event {
  return {
    v: 1,
    id,
    ts: '2026-10-23T00:00:00.000Z',
    stream: 'session:s',
    actor: 'agent',
    type,
    payload,
  }
}

test('system 注入排到未完成工具结果之后', () => {
  const messages = projectHistory([
    event('u', 'message.user', { text: '查一下' }),
    event('c', 'tool.call', { callId: 'c1', call: 'read', args: {} }),
    event('s', 'message.system', { text: '子 agent 完成', mark: 'injection' }),
    event('r', 'tool.result', { callId: 'c1', text: 'ok' }),
  ], { timeTag: false })

  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'system'])
  assert.match(JSON.stringify(messages.at(-1)), /子 agent 完成/)
})

test('多个工具结果都结束后才放注入', () => {
  const messages = projectHistory([
    event('u', 'message.user', { text: '并行查' }),
    event('c1', 'tool.call', { callId: 'c1', call: 'read', args: {} }),
    event('c2', 'tool.call', { callId: 'c2', call: 'read', args: {} }),
    event('s', 'message.system', { text: '注入', mark: 'injection' }),
    event('r1', 'tool.result', { callId: 'c1', text: 'one' }),
    event('r2', 'tool.result', { callId: 'c2', text: 'two' }),
  ], { timeTag: false })

  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'system'])
})
