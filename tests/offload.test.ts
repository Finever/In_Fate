import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BlobStore } from '../src/core/blobs.ts'
import { OffloadPolicy } from '../src/tools/offload.ts'
import { toolResultPayload } from '../src/tools/result-payload.ts'

function policy(): { dir: string; store: BlobStore; offload: OffloadPolicy } {
  const dir = mkdtempSync(join(tmpdir(), 'if-offload-'))
  const store = new BlobStore(join(dir, 'blobs'))
  return {
    dir,
    store,
    offload: new OffloadPolicy(store, {
      enabled: true,
      maxInlineBytes: 10,
      maxStructuredBytes: 10,
      previewHeadChars: 3,
      previewTailChars: 2,
    }),
  }
}

test('大文本写时卸载，预览可读，原文可取回', () => {
  const { dir, store, offload } = policy()
  try {
    const text = 'x'.repeat(1000)
    const result = offload.apply({
      text,
      bytes: 100,
      encoding: 'utf-8',
      mime: 'text/plain',
    })
    assert.match(result.text ?? '', /offloaded 1000 bytes/)
    assert.ok(result.contentRef?.ref.startsWith('blob:'))
    assert.ok((result.text ?? '').length < text.length)
    assert.equal(store.readText(result.contentRef!.ref).text, text)
    assert.equal(
      toolResultPayload('c1', result).contentRef,
      result.contentRef,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('小文本保持内联，大 structured 写 structuredRef', () => {
  const { dir, store, offload } = policy()
  try {
    const small = offload.apply({ text: 'ok' })
    assert.equal(small.text, 'ok')
    assert.equal(small.contentRef, undefined)

    const structured = { payload: 'y'.repeat(100) }
    const result = offload.apply({ text: 'ok', structured })
    assert.equal(result.structured, undefined)
    assert.ok(result.structuredRef?.ref.startsWith('blob:'))
    assert.deepEqual(JSON.parse(store.readText(result.structuredRef!.ref).text), structured)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
