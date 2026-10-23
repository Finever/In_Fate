import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FsPolicy } from '../src/core/fs-policy.ts'
import { readTool } from '../src/tools/builtin/read.ts'

test('读写在根目录内，越界拒绝', async () => {
  const base = mkdtempSync(join(tmpdir(), 'if-fs-policy-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  const secret = join(outside, 'secret.txt')
  writeFileSync(secret, 'secret', 'utf8')

  try {
    const policy = new FsPolicy({ readRoots: [root], writeRoots: [root] })
    assert.equal(policy.resolveWrite('inside.txt', root), join(root, 'inside.txt'))
    assert.throws(() => policy.resolveRead(secret, root), /outside allowed roots/)
    assert.throws(() => policy.resolveWrite(secret, root), /outside allowed roots/)

    await assert.rejects(
      readTool.run({ file_path: secret }, {
        sessionId: 's',
        callId: 'c',
        cwd: root,
        signal: new AbortController().signal,
        sandbox: policy,
      }),
      /outside allowed roots/,
    )
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('根目录内的链接不能逃到外面', () => {
  const base = mkdtempSync(join(tmpdir(), 'if-fs-link-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')

  try {
    const link = join(root, 'link')
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // 权限不足的环境跳过链接用例
      return
    }

    const policy = new FsPolicy({ readRoots: [root] })
    assert.throws(
      () => policy.resolveRead(join(link, 'secret.txt'), root),
      /escapes through symlink|outside allowed roots/,
    )
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
