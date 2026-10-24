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

import { closeSync, fstatSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
  private readonly startedAt: string
  private closedFlag = false

  private constructor(store: EventStore, lockPath: string, fd: number, startedAt: string) {
    this.store = store
    this.lockPath = lockPath
    this.fd = fd
    this.startedAt = startedAt
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
        return new SessionWriter(store, lockPath, fd, meta.startedAt)
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
    this.assertOwnership()
    return this.store.append(input)
  }

  flush(): void {
    if (this.closedFlag) return
    this.assertOwnership()
    this.store.flush()
  }

  /**
   * 锁文件可能被外部删掉再重建。写之前核对路径上的 inode 仍是我们 open
   * 的那一个；不是就说明所有权已经丢了，必须 fail-closed，不能继续写。
   * 这是 DSH 在 POSIX flock 之后核对 locked inode 的同一思路。
   */
  private assertOwnership(): void {
    let held: ReturnType<typeof fstatSync>
    try {
      held = fstatSync(this.fd)
    } catch {
      throw new IfStorageError(`session writer ownership lost: ${this.store.file}`)
    }
    const current = statSync(this.lockPath, { throwIfNoEntry: false })
    const meta = readLockMeta(this.lockPath)
    if (
      !current
      || current.ino !== held.ino
      || current.dev !== held.dev
      || meta?.pid !== process.pid
      || meta.startedAt !== this.startedAt
    ) {
      throw new IfStorageError(`session writer ownership lost: ${this.store.file}`)
    }
  }

  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    let owned = false
    try {
      const held = fstatSync(this.fd)
      const current = statSync(this.lockPath, { throwIfNoEntry: false })
      const meta = readLockMeta(this.lockPath)
      owned = Boolean(
        current
        && current.ino === held.ino
        && current.dev === held.dev
        && meta?.pid === process.pid
        && meta.startedAt === this.startedAt,
      )
    } catch {
      // 查不到就当作已经不拥有，宁可留下锁文件也不误删别人的
    }
    try {
      closeSync(this.fd)
    } catch {
      // fd 已经关了
    }
    if (owned) {
      try {
        unlinkSync(this.lockPath)
      } catch {
        // 已经不是我们的锁
      }
    }
  }
}
