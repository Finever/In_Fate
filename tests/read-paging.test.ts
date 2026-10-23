import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readTool } from '../src/tools/builtin/read.ts'

const context = {
  sessionId: 's',
  callId: 'call',
  cwd: process.cwd(),
  signal: new AbortController().signal,
}

test('read 支持按行 offset/limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-read-'))
  try {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'a\nb\nc', 'utf8')

    const first = await readTool.run({ file_path: file, offset: 1, limit: 1 }, context)
    assert.equal(first.text, 'b')
    assert.equal((first.structured as { totalLines: number }).totalLines, 3)
    assert.equal((first.structured as { eof: boolean }).eof, false)

    const last = await readTool.run({ file_path: file, offset: 2, limit: 1 }, context)
    assert.equal(last.text, 'c')
    assert.equal((last.structured as { eof: boolean }).eof, true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
