import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../src/core/events.ts'
import { buildCompactionIndex } from '../src/compaction/project.ts'
import { projectHistory, findProjectionStart } from '../src/projections/history.ts'
import type { CompactionPayload } from '../src/compaction/types.ts'

function event(id: string, type: string, payload: Record<string, unknown> = {}): Event {
  return {
    v: 1,
    id,
    ts: '2026-10-22T00:00:00.000Z',
    stream: 'session:s1',
    actor: 'agent',
    type,
    payload,
  }
}

function user(id: string, text: string): Event {
  return event(id, 'message.user', { text })
}

function assistant(id: string, text: string): Event {
  return event(id, 'message.assistant', { text })
}

function summary(): CompactionPayload {
  return {
    anchor: { stream: 'session:s1', fromEventId: 'u1', toEventId: 'a1' },
    summary: {
      goal: '旧目标',
      constraints: [],
      decisions: [],
      facts: [],
      failed: [],
      open: [],
    },
    stats: { tokensBefore: 100, tokensAfter: 20, foldedCount: 2, prunedCount: 0 },
    trigger: 'auto',
    phase: 'turn-start',
    strategy: 'hybrid',
  }
}

function baseEvents(): Event[] {
  const compacted: CompactionPayload = summary()
  return [
    event('s', 'session.created', { formatVersion: 2 }),
    user('u1', '第一轮'),
    assistant('a1', '回答一'),
    event('c1', 'context.compacted', compacted as unknown as Record<string, unknown>),
    user('u2', '第二轮'),
    assistant('a2', '回答二'),
    user('u3', '第三轮'),
    assistant('a3', '回答三'),
  ]
}

test('链尾覆盖全部旧消息时可以只投尾部', () => {
  const events = baseEvents()
  const index = buildCompactionIndex(events)
  const cut = findProjectionStart(events, index.ranges, false)
  assert.equal(cut?.start, 3)
  assert.equal(cut?.end, 2)

  const messages = projectHistory(events)
  assert.equal(messages[0]!.role, 'system')
  assert.match(
    String((messages[0]!.content[0] as { text?: string }).text ?? ''),
    /压缩摘要/,
  )
  assert.equal(messages.length, 5) // 摘要 + 第二/三轮四条
  assert.equal(
    messages.some(message => JSON.stringify(message).includes('第一轮')),
    false,
  )
})

test('链尾之前有未覆盖消息时不裁剪', () => {
  const events = baseEvents()
  // 在压缩区间之前插一条没有覆盖的旧消息
  events.splice(1, 0, user('u0', '未被压缩的旧消息'))
  const index = buildCompactionIndex(events)
  assert.equal(findProjectionStart(events, index.ranges, false), undefined)

  const messages = projectHistory(events)
  assert.equal(
    messages.some(message => JSON.stringify(message).includes('未被压缩的旧消息')),
    true,
  )
})
