import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionWriter } from '../src/core/session-writer.ts'
import { EventStore } from '../src/core/store.ts'

function tempStore(): { dir: string; store: EventStore } {
  const dir = mkdtempSync(join(tmpdir(), 'if-writer-'))
  return { dir, store: new EventStore(join(dir, 'session.jsonl')) }
}

test('写者持锁、拒绝第二个写者、关闭后可重开', () => {
  const { dir, store } = tempStore()
  try {
    const writer = SessionWriter.open(store)
    writer.append({
      stream: 'session:s',
      actor: 'system',
      type: 'session.created',
      payload: { formatVersion: 2 },
    })
    writer.append({
      stream: 'session:s',
      actor: 'user',
      type: 'message.user',
      payload: { text: 'a' },
    })
    assert.deepEqual(store.read().map(event => event.seq), [0, 1])
    assert.throws(() => SessionWriter.open(store), /session is busy/)

    writer.close()
    const reopened = SessionWriter.open(store)
    reopened.append({
      stream: 'session:s',
      actor: 'user',
      type: 'message.user',
      payload: { text: 'b' },
    })
    assert.equal(store.read().at(-1)!.seq, 2)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同机死进程留下的写者锁可接管', () => {
  const { dir, store } = tempStore()
  try {
    writeFileSync(`${store.file}.writer.lock`, JSON.stringify({
      pid: 2147483647,
      host: hostname(),
      startedAt: new Date(0).toISOString(),
    }), 'utf8')

    const writer = SessionWriter.open(store)
    writer.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
