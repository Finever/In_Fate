/**
 * 会话写者：同一会话同一时刻只允许一个长写者。
 *
 * 与 withFileLock 的短临界区不同，它持有 `<file>.writer.lock` 直到 close：
 *   - 主循环、子 agent 回送、压缩、归档都走同一个写者
 *   - 同机死进程留下的写者锁可以接管
 *   - 活锁直接报“会话忙”，不两个进程交错写
 *
 * @module if/core/session-writer
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import type { Event, NewEvent } from './events.ts'
import { lockIsStale, readLockMeta, type LockMeta } from './lock.ts'
import { IfStorageError, type EventStore } from './store.ts'

export interface SessionWriterOptions {
  /** 无主锁超过这个时间才算过期；默认 30 秒 */
  readonly staleMs?: number
}

export class SessionWriter {
  readonly store: EventStore
  readonly lockPath: string
  private readonly fd: number
  private closedFlag = false

  private constructor(store: EventStore, lockPath: string, fd: number) {
    this.store = store
    this.lockPath = lockPath
    this.fd = fd
  }

  static open(store: EventStore, options: SessionWriterOptions = {}): SessionWriter {
    mkdirSync(dirname(store.file), { recursive: true })
    const lockPath = `${store.file}.writer.lock`
    const staleMs = options.staleMs ?? 30_000

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, 'wx')
        const meta: LockMeta = {
          pid: process.pid,
          host: hostname(),
          startedAt: new Date().toISOString(),
        }
        try {
          writeFileSync(fd, JSON.stringify(meta), 'utf8')
        } catch (error) {
          closeSync(fd)
          try {
            unlinkSync(lockPath)
          } catch {
            // 交给下一次 stale 检查
          }
          throw error
        }
        return new SessionWriter(store, lockPath, fd)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

        if (lockIsStale(lockPath, readLockMeta(lockPath), staleMs)) {
          try {
            unlinkSync(lockPath)
          } catch {
            // 别人先清了
          }
          continue
        }

        throw new IfStorageError(`session is busy: ${store.file}`)
      }
    }

    throw new IfStorageError(`session is busy: ${store.file}`)
  }

  get closed(): boolean {
    return this.closedFlag
  }

  append(input: NewEvent): Event {
    if (this.closedFlag) throw new IfStorageError(`writer closed: ${this.store.file}`)
    return this.store.append(input)
  }

  flush(): void {
    if (this.closedFlag) return
    this.store.flush()
  }

  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    try {
      closeSync(this.fd)
    } catch {
      // fd 已经关了
    }
    try {
      unlinkSync(this.lockPath)
    } catch {
      // 已经不是我们的锁
    }
  }
}
