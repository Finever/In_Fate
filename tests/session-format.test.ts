import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { IfCorruptionError, EventStore } from '../src/core/store.ts'

function tempStore(): { dir: string; store: EventStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'if-session-'))
  const file = join(dir, 'session.jsonl')
  return { dir, store: new EventStore(file), file }
}

function created(store: EventStore): void {
  store.append({
    stream: 'session:s1',
    actor: 'system',
    type: 'session.created',
    payload: { sessionId: 's1', formatVersion: 2, seqBase: 0 },
  })
}

function user(store: EventStore, text: string): void {
  store.append({
    stream: 'session:s1',
    actor: 'user',
    type: 'message.user',
    payload: { text },
  })
}

test('新会话事件带格式版本与单调 seq', () => {
  const { dir, store } = tempStore()
  try {
    created(store)
    user(store, 'a')
    user(store, 'b')
    const events = store.read()
    assert.deepEqual(events.map(event => event.seq), [0, 1, 2])
    assert.equal(events[0]!.payload.formatVersion, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只容忍最后一段没有换行的半条尾行', () => {
  const { dir, store, file } = tempStore()
  try {
    created(store)
    user(store, 'a')
    appendFileSync(file, '{"v":1,"id":"half-written', 'utf8')

    assert.equal(store.read().length, 2)
    assert.equal(store.lineCount(), 2)

    user(store, 'b')
    const events = store.read()
    assert.equal(events.length, 3)
    assert.equal(events.at(-1)!.seq, 2)
    assert.equal(events.at(-1)!.payload.text, 'b')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('完整坏行仍然报错', () => {
  const { dir, store, file } = tempStore()
  try {
    created(store)
    appendFileSync(file, 'not-json\n', 'utf8')
    assert.throws(() => store.read(), IfCorruptionError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
