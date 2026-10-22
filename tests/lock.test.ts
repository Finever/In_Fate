import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { withFileLock } from '../src/core/lock.ts'

function tempTarget(): { dir: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'if-lock-'))
  return { dir, target: join(dir, 'session.jsonl') }
}

test('正常加锁、超时和释放', async () => {
  const { dir, target } = tempTarget()
  try {
    let release!: () => void
    const held = withFileLock(target, () => new Promise<void>(resolve => {
      release = resolve
    }))
    await delay(10)

    await assert.rejects(
      withFileLock(target, () => 1, { timeoutMs: 20, retryMs: 2 }),
      /lock timeout/,
    )

    release()
    await held

    // 释放后可以再次拿到
    assert.equal(await withFileLock(target, () => 7), 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同机死进程留下的锁会被清理', async () => {
  const { dir, target } = tempTarget()
  try {
    const lock = `${target}.lock`
    writeFileSync(lock, JSON.stringify({
      pid: 2147483647,
      host: hostname(),
      startedAt: new Date(0).toISOString(),
    }), 'utf8')

    const result = await withFileLock(target, () => 'ok', { timeoutMs: 500, retryMs: 5 })
    assert.equal(result, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('锁文件损坏时按 mtime 过期', async () => {
  const { dir, target } = tempTarget()
  try {
    const lock = `${target}.lock`
    writeFileSync(lock, 'not-json', 'utf8')
    const result = await withFileLock(target, () => 'ok', {
      timeoutMs: 200,
      retryMs: 5,
      staleMs: 0,
    })
    assert.equal(result, 'ok')
    assert.throws(() => readFileSync(lock, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
