import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../src/core/events.ts'
import { lastSeenPosition, pendingWakeMessages } from '../src/session/inbox.ts'

let counter = 0

function event(
  seq: number | undefined,
  type: string,
  payload: Record<string, unknown>,
  id = `e${++counter}`,
): Event {
  return {
    v: 1,
    ...(seq !== undefined ? { seq } : {}),
    id,
    ts: '2026-10-24T04:00:00.000Z',
    stream: 'session:s',
    actor: 'system',
    type,
    payload,
  }
}

function message(
  seq: number | undefined,
  messageId: string,
  wake: boolean,
  id = `m-${messageId}`,
): Event {
  return event(seq, 'session.message', {
    messageId,
    fromSession: 'other',
    kind: wake ? 'question' : 'note',
    text: `text ${messageId}`,
    ...(wake ? { wake: true } : {}),
  }, id)
}

test('没有完成轮时，所有 wake 消息都 pending，note 不算', () => {
  const events = [
    message(0, 'a', true),
    message(1, 'b', false),
    message(2, 'c', true),
  ]
  assert.equal(lastSeenPosition(events), -1)
  assert.deepEqual(pendingWakeMessages(events).map(item => item.messageId), ['a', 'c'])
})

test('消息在模型请求之后、turn.completed 之前落盘，仍然 pending', () => {
  const events = [
    message(0, 'seen', true),
    event(1, 'turn.completed', { lastSeenSeq: 0, status: 'completed' }),
    message(2, 'mid-turn', true),
    event(3, 'turn.completed', { lastSeenSeq: 0, status: 'completed' }),
  ]
  assert.equal(lastSeenPosition(events), 0)
  assert.deepEqual(pendingWakeMessages(events).map(item => item.messageId), ['mid-turn'])
})

test('最后一轮已经看到的消息不重复补跑', () => {
  const events = [
    message(4, 'a', true),
    message(5, 'b', true),
    event(6, 'turn.completed', { lastSeenSeq: 5, status: 'completed' }),
  ]
  assert.equal(lastSeenPosition(events), 5)
  assert.deepEqual(pendingWakeMessages(events), [])
})

test('后面的轮留下更低的 lastSeenSeq，不把已读消息重新变成未读', () => {
  const events = [
    message(1, 'seen', true),
    event(2, 'turn.completed', { lastSeenSeq: 1, status: 'completed' }),
    event(3, 'turn.completed', { lastSeenSeq: -1, status: 'failed' }),
  ]
  assert.equal(lastSeenPosition(events), 1)
  assert.deepEqual(pendingWakeMessages(events), [])
})

test('旧日志没有 seq 时退回下标，且最后一轮按自身位置封口', () => {
  const events = [
    message(undefined, 'old', true),
    event(undefined, 'turn.completed', {}),
    message(undefined, 'new', true),
  ]
  assert.equal(lastSeenPosition(events), 1)
  assert.deepEqual(pendingWakeMessages(events).map(item => item.messageId), ['new'])
})

test('同一个 messageId 只补一次', () => {
  const events = [
    message(0, 'dup', true, 'e-dup-1'),
    message(1, 'dup', true, 'e-dup-2'),
  ]
  assert.deepEqual(pendingWakeMessages(events).map(item => item.messageId), ['dup'])
})
