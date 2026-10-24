import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryCommitter } from '../src/memory/committer.ts'

test('memory root 是 git 仓库时按 dirty 批量提交', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-committer-'))
  try {
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'if@test.local'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'IF Test'], { cwd: dir })
    } catch {
      return // 环境没有 git 就跳过
    }

    mkdirSync(join(dir, 'detail', 'test'), { recursive: true })
    writeFileSync(join(dir, 'detail', 'test', 'notes.json'), '{"entries":[]}\n', 'utf8')
    execFileSync('git', ['add', 'detail'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })

    writeFileSync(join(dir, 'detail', 'test', 'notes.json'), '{"entries":[1]}\n', 'utf8')
    const committer = new MemoryCommitter(dir, { debounceMs: 1 })
    committer.markDirty('detail:test/notes')
    await committer.flush()

    const message = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' })
    assert.match(message, /memory: 自动提交/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
