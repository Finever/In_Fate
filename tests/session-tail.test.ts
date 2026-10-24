import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectEvents } from '../src/app/inspect.ts'
import {
  listSessions,
  readSessionTail,
  sessionStateOf,
  tailSessionState,
} from '../src/app/session.ts'
import { EventStore } from '../src/core/store.ts'

function seed(file: string, events: Array<{ type: string; payload?: Record<string, unknown> }>): EventStore {
  const store = new EventStore(file)
  store.append({
    stream: 'session:s',
    actor: 'system',
    type: 'session.created',
    payload: { sessionId: 's', formatVersion: 2 },
  })
  for (const event of events) {
    store.append({
      stream: 'session:s',
      actor: 'system',
      type: event.type,
      payload: event.payload ?? {},
    })
  }
  store.flush()
  return store
}

test('尾读状态：created=idle，progress=running，waiting=turn.completed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tail-state-'))
  try {
    const file = join(dir, 's.jsonl')
    seed(file, [])
    assert.equal(tailSessionState(file).state, 'idle')

    seed(file, [
      { type: 'message.user', payload: { text: 'go' } },
      { type: 'tool.call', payload: { callId: 'c1', call: 'read' } },
    ])
    assert.equal(tailSessionState(file).state, 'running')

    seed(file, [
      { type: 'turn.completed', payload: { status: 'waiting', lastSeenSeq: 1 } },
    ])
    assert.equal(tailSessionState(file).state, 'waiting')

    seed(file, [
      { type: 'turn.completed', payload: { status: 'completed', lastSeenSeq: 2 } },
    ])
    assert.equal(tailSessionState(file).state, 'idle')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('尾读忽略写了一半的最后一行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tail-torn-'))
  try {
    const file = join(dir, 's.jsonl')
    seed(file, [
      { type: 'message.user', payload: { text: 'go' } },
    ])
    appendFileSync(file, '{"type":"message.assistant","seq":99', 'utf8')
    const tail = readSessionTail(file)
    assert.equal(tail.events.at(-1)?.type, 'message.user')
    assert.equal(tailSessionState(file).state, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('尾读被截断时 total 仍取 lastSeq + 1，不拿尾段长度冒充全量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tail-truncate-'))
  try {
    const file = join(dir, 's.jsonl')
    seed(file, Array.from({ length: 24 }, (_, index) => ({
      type: 'message.user',
      payload: { text: `message-${index}` },
    })))
    const tail = readSessionTail(file, 256)
    assert.equal(tail.truncated, true)
    assert.ok(tail.events.length < tail.total)
    assert.equal(tail.total, 25)

    const inspection = inspectEvents('s', tail.events, undefined, {
      totalEvents: tail.total,
      truncated: true,
    })
    assert.equal(inspection.events, 25)
    assert.equal(inspection.lastSeq, 24)
    assert.equal(inspection.state, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('尾段落在一条超大事件中间时，向前扩到完整事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tail-bigline-'))
  try {
    const file = join(dir, 's.jsonl')
    seed(file, [
      { type: 'message.user', payload: { text: 'go' } },
      { type: 'tool.result', payload: { callId: 'c1', text: 'x'.repeat(20_000) } },
    ])
    const tail = readSessionTail(file, 512)
    assert.equal(tail.truncated, false)
    assert.equal(tail.events.at(-1)?.type, 'tool.result')
    assert.equal(tail.total, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('listSessions withState 给列表补 state/lastActivity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tail-list-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const store = new EventStore(join(dir, 'sessions', 'session-a.jsonl'))
    store.append({
      stream: 'session:session-a',
      actor: 'system',
      type: 'session.created',
      payload: { sessionId: 'session-a', formatVersion: 2, createdBy: 'user' },
    })
    store.append({
      stream: 'session:session-a',
      actor: 'user',
      type: 'message.user',
      payload: { text: 'go' },
    })
    store.flush()

    const sessions = listSessions(dir, { withState: true })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.state, 'running')
    assert.ok(sessions[0]?.lastActivity)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('sessionStateOf 覆盖 agent 终态与空事件', () => {
  assert.equal(sessionStateOf(undefined), 'unknown')
  assert.equal(sessionStateOf({ type: 'agent.completed' }), 'done')
  assert.equal(sessionStateOf({ type: 'agent.failed' }), 'done')
  assert.equal(sessionStateOf({ type: 'session.created' }), 'idle')
  assert.equal(sessionStateOf({ type: 'message.assistant' }), 'running')
})
