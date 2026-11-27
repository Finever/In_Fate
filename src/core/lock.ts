import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

export interface LockOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
  /** 无主/跨机锁超过这个时间才算过期 */
  readonly staleMs?: number
}

export interface LockMeta {
  readonly pid: number
  readonly host: string
  readonly startedAt: string
}

const HOST = hostname()

export function readLockMeta(path: string): LockMeta | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockMeta>
    if (typeof raw.pid !== 'number' || typeof raw.host !== 'string') return undefined
    return { pid: raw.pid, host: raw.host, startedAt: raw.startedAt ?? '' }
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限；ESRCH = 不存在。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function lockIsStale(path: string, meta: LockMeta | undefined, staleMs: number): boolean {
  if (meta?.host === HOST) return !pidAlive(meta.pid)
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs
  } catch {
    return false
  }
}

export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const path = `${target}.lock`
  const timeoutMs = options.timeoutMs ?? 5_000
  const retryMs = options.retryMs ?? 25
  const staleMs = options.staleMs ?? 30_000
  const started = Date.now()

  let fd: number | undefined
  while (fd === undefined) {
    try {
      fd = openSync(path, 'wx')
      const meta: LockMeta = { pid: process.pid, host: HOST, startedAt: new Date().toISOString() }
      try {
        writeFileSync(fd, JSON.stringify(meta), 'utf8')
      } catch (writeError) {
        closeSync(fd)
        fd = undefined
        try {
          unlinkSync(path)
        } catch {
          // 清理失败就交给下一次 stale 检查
        }
        throw writeError
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const meta = readLockMeta(path)
      if (lockIsStale(path, meta, staleMs)) {
        try {
          unlinkSync(path)
        } catch {
          // 别人先清了，继续重试
        }
        continue
      }

      if (Date.now() - started > timeoutMs) throw new Error(`lock timeout: ${path}`)
      await delay(retryMs)
    }
  }

  try {
    return await fn()
  } finally {
    closeSync(fd)
    try {
      unlinkSync(path)
    } catch {
      // 已经被别人清掉，不算错
    }
  }
}
