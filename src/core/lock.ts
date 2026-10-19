/**
 * 跨进程文件锁：创建 `<target>.lock`，失败重试，超时报错。
 *
 * 只用于“读-改-写”临界区；单次追加本身不强制加锁。
 *
 * @module if/core/lock
 */

import { closeSync, openSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

export interface LockOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
}

export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const path = `${target}.lock`
  const timeoutMs = options.timeoutMs ?? 5_000
  const retryMs = options.retryMs ?? 25
  const started = Date.now()

  let fd: number | undefined
  while (fd === undefined) {
    try {
      fd = openSync(path, 'wx')
    } catch {
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
