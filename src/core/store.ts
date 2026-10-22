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
  writeFileSync,
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
  private nextSeqCache?: number

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

    mkdirSync(dirname(this.file), { recursive: true })
    // 崩溃可能留下没有换行的半条尾行；只丢这半条，不动任何完整事件。
    this.repairTail()

    const isEmpty = input.type === 'session.created' && this.lineCount() === 0
    const seq = isEmpty ? 0 : this.nextSeq()
    if (isEmpty) this.nextSeqCache = 1

    const event: Event = {
      v: ENVELOPE_VERSION,
      ...(spec ? { tv: spec.version } : {}),
      seq,
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...input,
    }

    this.maybeRotate()
    try {
      appendFileSync(this.file, JSON.stringify(event) + '\n', { encoding: 'utf8' })
    } catch (error) {
      throw new IfStorageError(`append failed: ${this.file}`, error)
    }
    return event
  }

  /** 读全部事件（所有段，按段号顺序）。只容忍最后一段的半条尾行。 */
  read(): readonly Event[] {
    const segments = this.segments()
    const out: Event[] = []
    segments.forEach((segment, index) => {
      out.push(...this.readSegment(segment, 0, index === segments.length - 1))
    })
    return out
  }

  /** 从某条事件之后读；跨段查找，找不到就报错。 */
  readSince(eventId: string): readonly Event[] {
    const marker = `"id":"${eventId}"`
    const segments = this.segments()
    const out: Event[] = []
    let found = false

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!
      if (!existsSync(segment)) continue
      const lines = readFileSync(segment, 'utf8').split('\n')
      let start = 0

      if (!found) {
        const markerIndex = lines.findIndex(line => line.includes(marker))
        if (markerIndex < 0) continue
        start = markerIndex + 1
        found = true
      }

      out.push(...this.readSegment(segment, start, index === segments.length - 1))
    }

    if (!found) throw new IfStorageError(`event not found: ${eventId}`)
    return out
  }

  /** 当前段从第 line 行开始读；分段后行号不可靠，只作旧状态兼容。 */
  readFrom(line: number): readonly Event[] {
    return this.readSegment(this.file, line, true)
  }

  /** 所有段的行数总和。 */
  lineCount(): number {
    const segments = this.segments()
    return segments.reduce(
      (sum, segment, index) => sum + this.readSegment(segment, 0, index === segments.length - 1).length,
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

  private readSegment(file: string, startLine = 0, allowTruncatedTail = false): Event[] {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n')
    const out: Event[] = []

    for (let line = startLine; line < lines.length; line += 1) {
      const text = lines[line].trim()
      if (!text) continue
      try {
        out.push(JSON.parse(text) as Event)
      } catch {
        const restEmpty = lines.slice(line + 1).every(item => item.trim() === '')
        // 只有“最后一段、最后一条、没有换行”才按崩溃截断处理。
        if (allowTruncatedTail && restEmpty && !raw.endsWith('\n')) break
        throw new IfCorruptionError(file, line + 1)
      }
    }
    return out
  }

  private nextSeq(): number {
    if (this.nextSeqCache === undefined) this.nextSeqCache = this.lastSeq() + 1
    const seq = this.nextSeqCache
    this.nextSeqCache += 1
    return seq
  }

  private lastSeq(): number {
    const segments = this.segments()
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const events = this.readSegment(segments[index]!, 0, true)
      if (events.length === 0) continue
      const last = events[events.length - 1]!
      return typeof last.seq === 'number' ? last.seq : events.length - 1
    }
    return -1
  }

  /** 追加前修掉没有换行的半条尾行；完整的坏行不修，留给读取报错。 */
  private repairTail(): void {
    if (!existsSync(this.file)) return
    const raw = readFileSync(this.file, 'utf8')
    if (raw.length === 0 || raw.endsWith('\n')) return

    const cut = raw.lastIndexOf('\n')
    const tail = raw.slice(cut + 1)
    if (tail.trim() === '') {
      appendFileSync(this.file, '\n', { encoding: 'utf8' })
      return
    }

    try {
      JSON.parse(tail)
      // 行本身合法，只是没写换行；补上，不丢事件。
      appendFileSync(this.file, '\n', { encoding: 'utf8' })
    } catch {
      // 半条 JSON：只截到最后一个换行，保留之前所有完整事件。
      writeFileSync(this.file, cut >= 0 ? raw.slice(0, cut + 1) : '', { encoding: 'utf8' })
    }
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
