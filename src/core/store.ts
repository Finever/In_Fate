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
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ENVELOPE_VERSION, type Event, type NewEvent } from './events.ts'
import { assertWithin } from './safe-path.ts'
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
  /** 段缓存上限；默认 64 段 */
  readonly cacheMaxSegments?: number
}

interface SegmentCacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly events: readonly Event[]
}

export class EventStore {
  readonly file: string
  readonly segmentMaxBytes?: number
  private nextSeqCache?: number
  private dirty = false
  private readonly cache = new Map<string, SegmentCacheEntry>()
  private readonly cacheMaxSegments: number
  private readonly listeners = new Set<(event: Event) => void>()

  constructor(file: string, options: EventStoreOptions = {}) {
    this.file = file
    this.segmentMaxBytes = options.segmentMaxBytes
    this.cacheMaxSegments = options.cacheMaxSegments ?? 64
  }

  /** 多进程临界区：加锁后追加。 */
  async appendLocked(input: NewEvent, options: { timeoutMs?: number } = {}): Promise<Event> {
    return withFileLock(this.file, () => this.append(input), options)
  }

  /** 只在本进程内通知追加；监听器抛错不影响事件落盘。 */
  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 追加一条事件。注册过的类型先过校验器。 */
  append(input: NewEvent): Event {
    const spec = getEventSpec(input.type)
    spec?.validate?.(input.payload)

    mkdirSync(dirname(this.file), { recursive: true })
    // 崩溃可能留下没有换行的半条尾行；只丢这半条，不动任何完整事件。
    this.repairTail()

    const isEmpty = input.type === 'session.created' && !this.hasAnyEvents()
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
      this.dirty = true
      this.cache.delete(this.file)
    } catch (error) {
      throw new IfStorageError(`append failed: ${this.file}`, error)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 旁路订阅不能影响事件写入。
      }
    }
    return event
  }

  /**
   * 检查点：把已 append 的批次刷到磁盘。
   * 不是每条事件都 fsync；只在模型请求前、工具正文前、轮结束这些屏障调用。
   */
  flush(): void {
    if (!this.dirty || !existsSync(this.file)) return
    const fd = openSync(this.file, 'r+')
    try {
      fsyncSync(fd)
      this.dirty = false
    } finally {
      closeSync(fd)
    }
  }

  /** 读活跃段（归档段默认跳过）。只容忍最后一段的半条尾行。 */
  read(): readonly Event[] {
    const segments = this.segments()
    const out: Event[] = []
    segments.forEach((segment, index) => {
      out.push(...this.readSegmentCached(segment, index === segments.length - 1))
    })
    return out
  }

  /** 读全部段，包括已归档段；显式审计/recall 用。 */
  readAll(): readonly Event[] {
    const segments = this.allSegments()
    const out: Event[] = []
    segments.forEach((segment, index) => {
      out.push(...this.readSegmentCached(segment, index === segments.length - 1))
    })
    return out
  }

  /** 是否还有任何事件（含归档段）；别用 read().length 判断。 */
  hasAnyEvents(): boolean {
    return this.allSegments().some(segment => this.readSegmentCached(segment, true).length > 0)
  }

  /** 从某条事件之后读；跨段查找，找不到就报错。 */
  readSince(eventId: string): readonly Event[] {
    const segments = this.allSegments()
    const out: Event[] = []
    let found = false

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!
      const events = this.readSegmentCached(segment, index === segments.length - 1)
      let start = 0

      if (!found) {
        const markerIndex = events.findIndex(event => event.id === eventId)
        if (markerIndex < 0) continue
        start = markerIndex + 1
        found = true
      }

      out.push(...events.slice(start))
    }

    if (!found) throw new IfStorageError(`event not found: ${eventId}`)
    return out
  }

  /** 当前段从第 line 行开始读；分段后行号不可靠，只作旧状态兼容。 */
  readFrom(line: number): readonly Event[] {
    return this.readSegmentCached(this.file, true).slice(line)
  }

  /** 活跃段的行数总和。 */
  lineCount(): number {
    const segments = this.segments()
    return segments.reduce(
      (sum, segment, index) => sum + this.readSegmentCached(segment, index === segments.length - 1).length,
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

    const raw = readdirSync(dir)
    const archived = new Set(
      raw
        .filter(name => name.endsWith('.archived'))
        .map(name => name.slice(0, -'.archived'.length)),
    )
    const names = raw
      .filter(name => name === base || name.startsWith(`${base}.`))
      .filter(name => rank(name) >= 0 && !name.endsWith('.lock'))
      .filter(name => !archived.has(name))
      .sort((a, b) => rank(a) - rank(b))

    return names.length > 0 ? names.map(name => join(dir, name)) : [this.file]
  }

  /** 全部段，含已归档段；readAll/readSince/审计用。 */
  allSegments(): string[] {
    const dir = dirname(this.file)
    const base = basename(this.file)
    if (!existsSync(dir)) return [this.file]

    const rank = (name: string): number => {
      if (name === base) return Number.MAX_SAFE_INTEGER
      const suffix = Number(name.slice(base.length + 1))
      return Number.isFinite(suffix) ? suffix : -1
    }

    const names = new Set<string>()
    for (const raw of readdirSync(dir)) {
      if (raw !== base && !raw.startsWith(`${base}.`)) continue
      if (raw.endsWith('.lock')) continue
      const name = raw.endsWith('.archived') ? raw.slice(0, -'.archived'.length) : raw
      if (rank(name) >= 0) names.add(name)
    }

    return names.size > 0
      ? [...names].sort((a, b) => rank(a) - rank(b)).map(name => join(dir, name))
      : [this.file]
  }

  /** 给非当前段打归档标记；不删除原文件。 */
  archiveSegment(segment: string): void {
    const target = assertWithin(dirname(this.file), segment, 'segment')
    if (target === this.file) throw new IfStorageError(`cannot archive current segment: ${target}`)
    if (!existsSync(target)) throw new IfStorageError(`segment not found: ${target}`)
    writeFileSync(`${target}.archived`, '', { encoding: 'utf8' })
  }

  /** 读单个段（缓存），供归档判定/诊断；不影响活跃段列表。 */
  eventsOfSegment(segment: string): readonly Event[] {
    return this.readSegmentCached(segment, true)
  }

  private readSegmentCached(file: string, allowTruncatedTail = false): readonly Event[] {
    if (!existsSync(file)) return []
    const stat = statSync(file)
    const cached = this.cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.cache.delete(file)
      this.cache.set(file, cached)
      return cached.events
    }

    const events = this.readSegment(file, 0, allowTruncatedTail)
    this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events })
    while (this.cache.size > this.cacheMaxSegments) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined || oldest === this.file) break
      this.cache.delete(oldest)
    }
    return events
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
    const segments = this.allSegments()
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const events = this.readSegmentCached(segments[index]!, true)
      if (events.length === 0) continue
      const last = events[events.length - 1]!
      return typeof last.seq === 'number' ? last.seq : events.length - 1
    }
    return -1
  }

  /** 追加前修掉没有换行的半条尾行；完整的坏行不修，留给读取报错。 */
  private repairTail(): void {
    if (!existsSync(this.file)) return
    this.cache.delete(this.file)
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
    this.cache.delete(this.file)
  }
}
