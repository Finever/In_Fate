import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BlobError, BlobStore } from '../src/core/blobs.ts'

function temp(): { dir: string; store: BlobStore } {
  const dir = mkdtempSync(join(tmpdir(), 'if-blob-'))
  return { dir, store: new BlobStore(join(dir, 'blobs')) }
}

test('blob 写入、去重、范围读取与校验', () => {
  const { dir, store } = temp()
  try {
    const first = store.put('abcdef', { mime: 'text/plain', encoding: 'utf-8' })
    const second = store.put('abcdef')
    assert.equal(first.ref, second.ref)
    assert.match(first.ref, /^blob:[0-9a-f]{64}$/)
    assert.equal(first.bytes, 6)
    assert.equal(store.getBytes(first.ref).toString('utf8'), 'abcdef')
    assert.equal(store.verify(first.ref), true)

    const slice = store.readText(first.ref, { offset: 2, limit: 2 })
    assert.equal(slice.text, 'cd')
    assert.equal(slice.offset, 2)
    assert.equal(slice.totalChars, 6)
    assert.equal(slice.eof, false)
    assert.equal(store.readText(first.ref, { offset: 5, limit: 10 }).eof, true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('非法 ref、缺失与路径穿越被拒绝', () => {
  const { dir, store } = temp()
  try {
    assert.throws(() => store.getBytes('blob:abc'), BlobError)
    assert.throws(() => store.getBytes('spill:0123456789abcdef0123456789abcdef01234567'), BlobError)
    assert.throws(() => store.getBytes(`blob:${'0'.repeat(64)}`), BlobError)
    assert.throws(() => store.readText('blob:../x'), BlobError)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
