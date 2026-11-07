import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('记忆根没有 .git、detail 是仓库时也能提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'if-committer-detail-'))
  const detail = join(root, 'detail')
  try {
    mkdirSync(join(detail, 'test'), { recursive: true })
    try {
      execFileSync('git', ['init'], { cwd: detail, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'if@test.local'], { cwd: detail })
      execFileSync('git', ['config', 'user.name', 'IF Test'], { cwd: detail })
    } catch {
      return
    }
    writeFileSync(join(detail, 'test', 'notes.json'), '{"entries":[]}\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: detail })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: detail, stdio: 'ignore' })

    writeFileSync(join(detail, 'test', 'notes.json'), '{"entries":[1]}\n', 'utf8')
    const committer = new MemoryCommitter(root, { debounceMs: 1 })
    committer.markDirty('detail:test/notes')
    await committer.flush()

    const message = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: detail,
      encoding: 'utf8',
    })
    assert.match(message, /memory: 自动提交/)
    assert.equal(existsSync(join(detail, 'indexlist.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('自动提交关闭时仍记录 dirty，可手动提交', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-committer-manual-'))
  try {
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'if@test.local'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'IF Test'], { cwd: dir })
    } catch {
      return
    }
    mkdirSync(join(dir, 'detail', 'test'), { recursive: true })
    writeFileSync(join(dir, 'detail', 'test', 'notes.json'), '{"entries":[]}\n', 'utf8')
    execFileSync('git', ['add', 'detail'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })

    writeFileSync(join(dir, 'detail', 'test', 'notes.json'), '{"entries":[1]}\n', 'utf8')
    const committer = new MemoryCommitter(dir, { enabled: false })
    committer.markDirty('detail:test/notes')
    assert.deepEqual(committer.status().dirty, ['detail:test/notes'])
    await committer.commitNow()

    const message = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' })
    assert.match(message, /memory: 手动提交/)
    assert.deepEqual(committer.status().dirty, [])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
