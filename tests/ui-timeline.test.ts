import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../src/core/events.ts'
import { projectUiTimeline } from '../src/ui/timeline.ts'
import { slicePayload } from '../src/ui/api.ts'

let seq = 0

function event(
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
): Event {
  return {
    v: 1,
    seq: seq++,
    id,
    ts: '2026-10-22T00:00:00.000Z',
    stream: 'session:s1',
    actor: 'agent',
    type,
    payload,
  }
}

function baseEvents(): Event[] {
  seq = 0
  return [
    event('s', 'session.created', { formatVersion: 2 }),
    event('u1', 'message.user', { text: '第一轮问题' }),
    event('c1', 'tool.call', { callId: 'call1', call: 'read', args: { file_path: 'a.txt' } }),
    event('r1', 'tool.result', {
      callId: 'call1',
      text: 'x'.repeat(1000),
      ref: 'spill:0123456789abcdef0123456789abcdef01234567',
      bytes: 1000,
      encoding: 'utf-8',
      mime: 'text/plain',
      isError: false,
    }),
    event('a1', 'message.assistant', { text: '第一轮回答' }),
    event('k1', 'context.compacted', {
      anchor: { stream: 'session:s1', fromEventId: 'u1', toEventId: 'a1' },
      summary: { goal: '旧目标', constraints: [], decisions: [], facts: [], failed: [], open: [] },
      stats: { tokensBefore: 100, tokensAfter: 20, foldedCount: 4, prunedCount: 0 },
      trigger: 'auto',
      phase: 'turn-start',
      strategy: 'hybrid',
    }),
    event('t1', 'turn.completed', {
      steps: 2,
      usage: { input: 10, output: 5, cacheRead: 2 },
      aborted: false,
      hitLimit: false,
    }),
    event('u2', 'message.user', { text: '第二轮问题' }),
    event('a2', 'message.assistant', { text: '第二轮回答' }),
    event('t2', 'turn.completed', {
      steps: 1,
      usage: { input: 3, output: 2, cacheRead: 0 },
      aborted: false,
      hitLimit: false,
    }),
  ]
}

test('时间线按轮分组，工具调用与结果配对', () => {
  const page = projectUiTimeline('s1', baseEvents(), { limit: 10 })
  assert.equal(page.turns, 2)
  assert.equal(page.hasMoreBefore, false)
  assert.equal(page.hasMoreAfter, false)

  const tool = page.items.find(item => item.kind === 'tool')
  assert.ok(tool?.tool)
  assert.equal(tool.tool.callId, 'call1')
  assert.equal(tool.tool.name, 'read')
  assert.equal(tool.tool.status, 'ok')
  assert.match(tool.tool.result!.preview, /…/)
  assert.equal(tool.tool.result!.ref, 'spill:0123456789abcdef0123456789abcdef01234567')
  assert.equal(tool.tool.result!.truncated, true)

  const compaction = page.items.find(item => item.kind === 'compaction')
  assert.ok(compaction)
  assert.match(compaction.content!.preview, /旧目标/)
})

test('分页不切断一轮，游标可向上/向下', () => {
  const all = baseEvents()
  const latest = projectUiTimeline('s1', all, { limit: 1 })
  assert.equal(latest.turns, 1)
  assert.equal(latest.hasMoreBefore, true)
  assert.equal(latest.hasMoreAfter, false)
  assert.deepEqual(latest.items.map(item => item.kind), ['user', 'assistant', 'turn'])
  assert.equal(latest.items[0]!.seq, 7)

  const first = projectUiTimeline('s1', all, { limit: 1, before: latest.nextBefore })
  assert.equal(first.turns, 1)
  assert.equal(first.hasMoreBefore, false)
  assert.equal(first.hasMoreAfter, true)
  assert.equal(first.items.some(item => item.kind === 'tool'), true)
})

test('轮次耗时取用户消息到 turn.completed 的事件时间差', () => {
  seq = 0
  const events: Event[] = [
    event('s', 'session.created', { formatVersion: 2 }),
    { ...event('u1', 'message.user', { text: '问题' }), ts: '2026-10-22T00:00:00.000Z' },
    { ...event('a1', 'message.assistant', { text: '回答' }), ts: '2026-10-22T00:00:10.000Z' },
    {
      ...event('t1', 'turn.completed', {
        steps: 1,
        usage: { input: 1, output: 1, cacheRead: 0 },
        aborted: false,
        hitLimit: false,
      }),
      ts: '2026-10-22T00:00:12.400Z',
    },
  ]
  const page = projectUiTimeline('s1', events, { limit: 10 })
  const turn = page.items.find(item => item.kind === 'turn')
  assert.equal(turn?.turnUsage?.durationMs, 12_400)
})

test('payload 按字符切片并报告 eof', () => {
  const slice = slicePayload('abcdef', 2, 2)
  assert.equal(slice.data, 'cd')
  assert.equal(slice.offset, 2)
  assert.equal(slice.totalChars, 6)
  assert.equal(slice.eof, false)
  assert.equal(slice.bytes, 2)

  const tail = slicePayload('abcdef', 5, 10)
  assert.equal(tail.data, 'f')
  assert.equal(tail.eof, true)
})
