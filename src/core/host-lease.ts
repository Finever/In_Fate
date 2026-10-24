/**
 * 进程级 host 锁：一个 dataRoot 同时只允许一个 host。
 *
 * 借鉴 DSH 的 session write lease：锁由内核持有，进程退出（包括崩溃）就
 * 自动释放，**不设 TTL**。一个还活着但卡死的 host 不该被后来者抢锁，否则
 * 两边会同时写同一份事件流。
 *
 * Node 没有 flock，这里用 Node 24 自带的 `node:sqlite`：在
 * `dataRoot/locks/host.db` 上开一个长期 `BEGIN IMMEDIATE` 事务。SQLite 的
 * POSIX fcntl / Windows LockFileEx 由内核维护，进程死亡时释放；第二个 host
 * 的 `BEGIN IMMEDIATE` 会立刻拿到 SQLITE_BUSY（errcode 5）。
 *
 * `host.holder.json` 只用于诊断，不参与判锁——它可能是崩溃留下的旧文件，
 * 真正的锁始终是那个打开的事务。
 *
 * @module if/core/host-lease
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface HostLeaseHolder {
  readonly pid: number
  readonly host: string
  readonly startedAt: string
}

export interface HostLeaseOptions {
  /** 不配就用 `<dataRoot>/locks` */
  readonly lockDir?: string
  readonly now?: () => Date
}

export class HostAlreadyRunningError extends Error {
  readonly lockPath: string
  readonly holder?: HostLeaseHolder

  constructor(lockPath: string, holder?: HostLeaseHolder) {
    const who = holder
      ? ` (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`
      : ''
    super(`another IF host is already running for this data root${who}; lock: ${lockPath}`)
    this.name = 'HostAlreadyRunningError'
    this.lockPath = lockPath
    if (holder) this.holder = holder
  }
}

const SQLITE_BUSY = 5

function sqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode
  if (code === SQLITE_BUSY) return true
  return /database is locked/i.test((error as Error | null)?.message ?? '')
}

export function readHostHolder(path: string): HostLeaseHolder | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostLeaseHolder>
    if (typeof raw.pid !== 'number' || typeof raw.host !== 'string') return undefined
    return {
      pid: raw.pid,
      host: raw.host,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    }
  } catch {
    return undefined
  }
}

function writeHostHolder(path: string, holder: HostLeaseHolder): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(holder, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/** 一个已持有的 host 锁；`release` 回滚事务并关闭连接，内核随即释放锁。 */
export class HostLease {
  private readonly db: DatabaseSync
  private readonly holderPath: string
  private released = false

  readonly lockPath: string
  readonly holder: HostLeaseHolder

  private constructor(
    db: DatabaseSync,
    lockPath: string,
    holderPath: string,
    holder: HostLeaseHolder,
  ) {
    this.db = db
    this.lockPath = lockPath
    this.holderPath = holderPath
    this.holder = holder
  }

  /**
   * 取得 dataRoot 的 host 锁。同步操作，失败时抛出
   * {@link HostAlreadyRunningError}。
   */
  static acquire(dataRoot: string, options: HostLeaseOptions = {}): HostLease {
    const dir = options.lockDir ?? join(dataRoot, 'locks')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lockPath = join(dir, 'host.db')
    const holderPath = join(dir, 'host.holder.json')

    // 不给 0 字节文件一个可预测的权限窗口；Windows 会忽略 mode。
    if (!existsSync(lockPath)) {
      try {
        closeSync(openSync(lockPath, 'a', 0o600))
      } catch {
        // 创建竞争失败就让 DatabaseSync 自己报错
      }
    }

    const db = new DatabaseSync(lockPath)
    let began = false
    try {
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('BEGIN IMMEDIATE')
      began = true
      db.exec(`
        CREATE TABLE IF NOT EXISTS host_lease (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          pid        INTEGER NOT NULL,
          host       TEXT NOT NULL,
          started_at TEXT NOT NULL
        ) STRICT
      `)
      const holder: HostLeaseHolder = {
        pid: process.pid,
        host: hostname(),
        startedAt: (options.now?.() ?? new Date()).toISOString(),
      }
      db.prepare(
        'INSERT OR REPLACE INTO host_lease (id, pid, host, started_at) VALUES (1, ?, ?, ?)',
      ).run(holder.pid, holder.host, holder.startedAt)
      // 行本身留在未提交事务里；诊断文件放在事务外，崩溃后也不会误导判锁。
      writeHostHolder(holderPath, holder)
      return new HostLease(db, lockPath, holderPath, holder)
    } catch (error) {
      if (began) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 原始的失败更重要
        }
      }
      try {
        db.close()
      } catch {
        // close 失败不覆盖原始原因
      }
      if (!began && sqliteBusy(error)) {
        throw new HostAlreadyRunningError(lockPath, readHostHolder(holderPath))
      }
      throw error
    }
  }

  get active(): boolean {
    return !this.released
  }

  /** 幂等。回滚未提交的持锁事务，再关闭连接。 */
  release(): void {
    if (this.released) return
    this.released = true
    try {
      this.db.exec('ROLLBACK')
    } finally {
      this.db.close()
      const current = readHostHolder(this.holderPath)
      if (current?.pid === this.holder.pid && current.host === this.holder.host) {
        try {
          rmSync(this.holderPath, { force: true })
        } catch {
          // 诊断文件删不掉不影响锁已经释放
        }
      }
    }
  }

  dispose(): void {
    this.release()
  }
}
