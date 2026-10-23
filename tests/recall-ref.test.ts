import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BlobStore } from '../src/core/blobs.ts'
import { EventStore } from '../src/core/store.ts'
import { createRecallTool } from '../src/tools/builtin/recall.ts'
import { FileSpillStore } from '../src/tools/spill.ts'

function context(sessionId = 's'): {
  sessionId: string
  callId: string
  cwd: string
  signal: AbortSignal
} {
  return {
    sessionId,
    callId: 'call',
    cwd: process.cwd(),
    signal: new AbortController().signal,
  }
}

test('recall 按 ref 取 blob 切片', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-recall-blob-'))
  try {
    const blobs = new BlobStore(join(dir, 'blobs'))
    const store = new EventStore(join(dir, 'session.jsonl'))
    const ref = blobs.put('abcdefghij')
    const tool = createRecallTool(store, { blobs })

    const result = await tool.run({ ref: ref.ref, offset: 2, limit: 3 }, context())
    assert.equal(result.text, 'cde')
    assert.equal((result.structured as { eof: boolean }).eof, false)
    assert.equal((result.structured as { totalChars: number }).totalChars, 10)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('recall 兼容旧 spill ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-recall-spill-'))
  try {
    const spill = new FileSpillStore(join(dir, 'spill'))
    const store = new EventStore(join(dir, 'session.jsonl'))
    const ref = spill.put('0123456789')
    const tool = createRecallTool(store, { spill })

    const result = await tool.run({ ref, offset: 4, limit: 3 }, context())
    assert.equal(result.text, '456')
    assert.equal((result.structured as { source: string }).source, 'spill')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
