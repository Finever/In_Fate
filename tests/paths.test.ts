import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertSafeSessionId, assertWithin, IfPathError } from '../src/core/safe-path.ts'
import { sessionFile } from '../src/app/session.ts'
import { parseAddress } from '../src/memory/quote.ts'
import { FileSpillStore } from '../src/tools/spill.ts'

test('sessionId 只接受安全段', () => {
  assert.equal(assertSafeSessionId('session-2026-10-22-abcd'), 'session-2026-10-22-abcd')
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'x y', 'x:y', 'CON', 'nul.jsonl', 'trailing.']) {
    assert.throws(() => assertSafeSessionId(bad), IfPathError, bad)
  }
})

test('sessionFile 不会逃出 sessions 目录', () => {
  const root = join(tmpdir(), 'if-data')
  assert.equal(
    sessionFile(root, 'session-1'),
    join(root, 'sessions', 'session-1.jsonl'),
  )
  assert.throws(() => sessionFile(root, '../../outside'), IfPathError)
})

test('logAddr 拒绝路径穿越并保留合法地址', () => {
  const parsed = parseAddress('2026-10-21-demo-session-34')
  assert.deepEqual(parsed, {
    date: '2026-10-21',
    session: 'demo-session',
    n: 34,
  })
  assert.throws(() => parseAddress('2026-10-21-../evil-1'))
  assert.throws(() => parseAddress('2026-10-21-session-0'))
})

test('assertWithin 拒绝根目录之外', () => {
  const root = join(tmpdir(), 'if-root')
  assert.equal(assertWithin(root, join(root, 'a', 'b.txt')), join(root, 'a', 'b.txt'))
  assert.throws(() => assertWithin(root, join(root, '..', 'outside.txt')), IfPathError)
})

test('spill ref 不能带路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-spill-'))
  try {
    const store = new FileSpillStore(dir)
    const ref = store.put('hello')
    assert.match(ref, /^spill:[0-9a-f]{40}$/)
    assert.equal(store.get(ref), 'hello')
    assert.throws(() => store.get('spill:../../etc/passwd'), IfPathError)
    assert.throws(() => store.get('blob:abc'), IfPathError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
