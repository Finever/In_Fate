import assert from 'node:assert/strict'
import test from 'node:test'
import { bashTool } from '../src/tools/builtin/bash.ts'

const context = {
  sessionId: 'test',
  callId: 'call',
  cwd: process.cwd(),
  signal: new AbortController().signal,
}

test('短输出保留 stdout/stderr 分流', async () => {
  const result = await bashTool.run({ command: "printf 'hello'" }, context)
  const structured = result.structured as { stdout?: string; stderr?: string; code: number }
  assert.equal(structured.stdout, 'hello')
  assert.equal(structured.stderr, '')
  assert.equal(structured.code, 0)
  assert.match(result.text ?? '', /hello/)
})

test('长输出不再复制第二份到 structured', async () => {
  const result = await bashTool.run({
    command: `node -e "process.stdout.write('x'.repeat(20000))"`,
  }, context)
  const structured = result.structured as {
    stdout?: string
    stdoutBytes: number
    code: number
  }
  assert.equal(structured.stdout, undefined)
  assert.equal(structured.stdoutBytes, 20000)
  assert.equal(structured.code, 0)
  assert.equal((result.text ?? '').length, 20000)
})
