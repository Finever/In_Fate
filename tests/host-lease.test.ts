import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  HostAlreadyRunningError,
  HostLease,
  readHostHolder,
} from '../src/core/host-lease.ts'

const source = fileURLToPath(new URL('../src/core/host-lease.ts', import.meta.url))

test('host lease：同一 dataRoot 第二把锁被拒绝，释放后可重取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-host-lease-'))
  try {
    const first = HostLease.acquire(dir, {
      now: () => new Date('2026-10-24T04:00:00.000Z'),
    })
    assert.equal(first.holder.pid, process.pid)
    assert.equal(first.holder.startedAt, '2026-10-24T04:00:00.000Z')
    const holderPath = join(dir, 'locks', 'host.holder.json')
    assert.equal(readHostHolder(holderPath)?.pid, process.pid)

    assert.throws(
      () => HostLease.acquire(dir),
      (error: unknown) => {
        assert.ok(error instanceof HostAlreadyRunningError)
        assert.equal(error.holder?.pid, process.pid)
        return true
      },
    )

    first.release()
    assert.equal(first.active, false)
    assert.equal(existsSync(holderPath), false)

    const second = HostLease.acquire(dir)
    assert.equal(second.active, true)
    second.release()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('host lease：持有者进程被杀后内核释放锁', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-host-lease-kill-'))
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `
      import { HostLease } from ${JSON.stringify(pathToFileURL(source).href)}
      HostLease.acquire(${JSON.stringify(dir)})
      process.stdout.write('held\\n')
      setInterval(() => {}, 1000)
    `,
  ], { stdio: ['ignore', 'pipe', 'inherit'] })

  const ready = new Promise<string>((resolve, reject) => {
    let text = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      text += chunk
      if (text.includes('held')) resolve(text)
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (!text.includes('held')) reject(new Error(`child exited early: ${code}`))
    })
  })

  try {
    await ready
    assert.throws(() => HostLease.acquire(dir), HostAlreadyRunningError)
    child.kill('SIGKILL')

    const deadline = Date.now() + 5_000
    let lease: HostLease | undefined
    while (!lease && Date.now() < deadline) {
      try {
        lease = HostLease.acquire(dir)
      } catch (error) {
        if (!(error instanceof HostAlreadyRunningError)) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    assert.ok(lease, 'child 被杀后锁应由内核释放')
    lease.release()
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
