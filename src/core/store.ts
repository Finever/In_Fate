/**
 * 事件存储：只追加的 JSONL，可按大小分段。
 *
 * 当前段是 `file`；写满后重命名为 `file.<n>`，新建 `file`。
 * `read()` 合并所有段；`readSince(eventId)` 跨段找游标。
 * 行号只在不分段时可靠，归档器改用事件 id。
 *
 * @module if/core/store
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ENVELOPE_VERSION, type Event, type NewEvent } from './events.ts'
import { withFileLock } from './lock.ts'
import { getEventSpec } from './registry.ts'

export class IfStorageError extends Error {
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'IfStorageError'
    this.cause = cause
  }
}

export class IfCorruptionError extends IfStorageError {
  readonly file: string
  readonly line: number

  constructor(file: string, line: number) {
    super(`corrupt event log: ${file}:${line}`)
    this.name = 'IfCorruptionError'
    this.file = file
    this.line = line
  }
}

export interface EventStoreOptions {
  /** 单段字节上限；不设就不分段 */
  readonly segmentMaxBytes?: number
}

export class EventStore {
  readonly file: string
  readonly segmentMaxBytes?: number

  constructor(file: string, options: EventStoreOptions = {}) {
    this.file = file
    this.segmentMaxBytes = options.segmentMaxBytes
  }

  /** 多进程临界区：加锁后追加。 */
  async appendLocked(input: NewEvent, options: { timeoutMs?: number } = {}): Promise<Event> {
    return withFileLock(this.file, () => this.append(input), options)
  }

  /** 追加一条事件。注册过的类型先过校验器。 */
  append(input: NewEvent): Event {
    const spec = getEventSpec(input.type)
    spec?.validate?.(input.payload)

    const event: Event = {
      v: ENVELOPE_VERSION,
      ...(spec ? { tv: spec.version } : {}),
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...input,
    }

    mkdirSync(dirname(this.file), { recursive: true })
    this.maybeRotate()
    try {
      appendFileSync(this.file, JSON.stringify(event) + '\n', { encoding: 'utf8' })
    } catch (error) {
      throw new IfStorageError(`append failed: ${this.file}`, error)
    }
    return event
  }

  /** 读全部事件（所有段，按段号顺序）。 */
  read(): readonly Event[] {
    const out: Event[] = []
    for (const segment of this.segments()) {
      out.push(...this.readSegment(segment))
    }
    return out
  }

  /** 从某条事件之后读；跨段查找，找不到就报错。 */
  readSince(eventId: string): readonly Event[] {
    const marker = `"id":"${eventId}"`
    const out: Event[] = []
    let found = false

    for (const segment of this.segments()) {
      const lines = readFileSync(segment, 'utf8').split('\n')
      let start = 0

      if (!found) {
        const index = lines.findIndex(line => line.includes(marker))
        if (index < 0) continue
        start = index + 1
        found = true
      }

      for (let line = start; line < lines.length; line += 1) {
        const text = lines[line].trim()
        if (!text) continue
        try {
          out.push(JSON.parse(text) as Event)
        } catch {
          throw new IfCorruptionError(segment, line + 1)
        }
      }
    }

    if (!found) throw new IfStorageError(`event not found: ${eventId}`)
    return out
  }

  /** 当前段从第 line 行开始读；分段后行号不可靠，只作旧状态兼容。 */
  readFrom(line: number): readonly Event[] {
    return this.readSegment(this.file, line)
  }

  /** 所有段的行数总和。 */
  lineCount(): number {
    return this.segments().reduce(
      (sum, segment) => sum + this.readSegment(segment).length,
      0,
    )
  }

  /** 段文件列表：`file.1`、`file.2`…，最后是当前 `file`。 */
  segments(): string[] {
    const dir = dirname(this.file)
    const base = basename(this.file)
    if (!existsSync(dir)) return [this.file]

    const rank = (name: string): number => {
      if (name === base) return Number.MAX_SAFE_INTEGER
      const suffix = Number(name.slice(base.length + 1))
      return Number.isFinite(suffix) ? suffix : -1
    }

    const names = readdirSync(dir)
      .filter(name => name === base || name.startsWith(`${base}.`))
      .filter(name => rank(name) >= 0 && !name.endsWith('.lock'))
      .sort((a, b) => rank(a) - rank(b))

    return names.length > 0 ? names.map(name => join(dir, name)) : [this.file]
  }

  private readSegment(file: string, startLine = 0): Event[] {
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n')
    const out: Event[] = []

    for (let line = startLine; line < lines.length; line += 1) {
      const text = lines[line].trim()
      if (!text) continue
      try {
        out.push(JSON.parse(text) as Event)
      } catch {
        throw new IfCorruptionError(file, line + 1)
      }
    }
    return out
  }

  private maybeRotate(): void {
    if (!this.segmentMaxBytes) return
    if (!existsSync(this.file)) return
    if (statSync(this.file).size < this.segmentMaxBytes) return

    const base = basename(this.file)
    const dir = dirname(this.file)
    const existing = this.segments()
      .filter(path => path !== this.file)
      .map(path => Number(basename(path).slice(base.length + 1)))
      .filter(Number.isFinite)
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
    renameSync(this.file, join(dir, `${base}.${next}`))
  }
}
