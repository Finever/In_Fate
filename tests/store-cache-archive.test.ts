import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'

function append(store: EventStore, text: string, type = 'message.user'): void {
  store.append({ stream: 'session:s', actor: 'user', type, payload: { text } })
}

test('段缓存下 read/readAll/归档与 seq 继续', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-store-archive-'))
  try {
    const store = new EventStore(join(dir, 'session.jsonl'), { segmentMaxBytes: 260 })
    store.append({
      stream: 'session:s', actor: 'system', type: 'session.created', payload: { formatVersion: 2 },
    })
    for (let index = 0; index < 20; index += 1) append(store, `消息 ${index} ${'x'.repeat(20)}`)

    const allSegments = store.allSegments()
    assert.ok(allSegments.length > 1)
    const beforeAll = store.readAll().length
    const beforeActive = store.read().length
    assert.equal(beforeAll, beforeActive)

    const old = allSegments.find(segment => segment !== store.file)
    assert.ok(old)
    store.archiveSegment(old!)

    assert.ok(store.readAll().length > store.read().length)
    assert.equal(store.hasAnyEvents(), true)
    assert.equal(store.lineCount(), store.read().length)

    const lastSeqBefore = store.readAll().at(-1)!.seq ?? -1
    append(store, '归档后新消息')
    const lastSeqAfter = store.readAll().at(-1)!.seq ?? -1
    assert.equal(lastSeqAfter, (lastSeqBefore ?? -1) + 1)

    // readSince 仍跨归档段
    const firstId = store.readAll()[0]!.id
    assert.ok(store.readSince(firstId).length > 0)

    // 缓存命中后仍然能读到新追加
    assert.equal(store.read().at(-1)!.payload.text, '归档后新消息')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
