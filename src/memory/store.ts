/**
 * detail 记忆存储：按目标文件分片读写，不做全库锁。
 *
 * 同一个 target 串行，不同 target 可以并行；跨进程用目标文件锁。
 * 只接受逻辑地址 `detail:<domain>/<file>`，不接受任意文件路径。
 *
 * @module if/memory/store
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from '../core/lock.ts'
import { assertWithin } from '../core/safe-path.ts'
import { validateFile, type Issue, type ValidationResult } from './validate.ts'

export type MemoryTag = '确信' | '可信' | '有疑'

export interface MemoryQuote {
  readonly say: string
  readonly at?: string | null
  readonly tag?: readonly string[]
  readonly 'log-addr'?: string
}

export interface MemoryEntry {
  readonly id: string
  readonly 'rec-time': string
  readonly 'rev-time': string | null
  readonly at: string | null
  readonly tag: MemoryTag
  readonly content: string
  readonly quotes?: readonly MemoryQuote[]
}

export interface MemoryDocument {
  readonly project: string
  readonly filename: string
  readonly introduction: string
  readonly entries: readonly MemoryEntry[]
}

export interface MemoryTarget {
  readonly target: string
  readonly domain: string
  readonly file: string
  readonly path: string
}

export interface MemoryAddInput {
  readonly content: string
  readonly tag: MemoryTag
  readonly at?: string | null
  readonly quotes?: readonly MemoryQuote[]
  /** 新文件必填 */
  readonly introduction?: string
}

export interface MemoryUpdateInput {
  readonly content?: string
  readonly tag?: MemoryTag
  readonly at?: string | null
  readonly quotes?: readonly MemoryQuote[]
  /** 乐观并发：当前 rev-time 不等于它就拒绝 */
  readonly expectedRevTime?: string | null
}

export interface MemorySearchHit {
  readonly target: string
  readonly id: string
  readonly tag: MemoryTag
  readonly preview: string
  readonly filename: string
}

export interface MemoryFileSummary {
  readonly domain: string
  readonly project: string
  readonly filename: string
  readonly target: string
  readonly introduction: string
  readonly entries: number
  readonly quotes: number
  readonly bytes: number
  readonly updatedAt: string
}

export class MemoryValidationError extends Error {
  readonly result: ValidationResult

  constructor(result: ValidationResult) {
    super(`memory validation failed: ${
      result.errors.map(issue => `${issue.path}: ${issue.message}`).join('; ')
    }`)
    this.name = 'MemoryValidationError'
    this.result = result
  }
}

const TAGS = new Set<MemoryTag>(['确信', '可信', '有疑'])
const BAD_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const LOG_ADDR = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9-]+-\d+$/

function assertMemorySegment(value: string, label: string): string {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || BAD_SEGMENT.test(value)
    || /[. ]$/.test(value)
    || RESERVED.test(value)
  ) {
    throw new Error(`unsafe memory ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

export function parseDetailTarget(memoryRoot: string, value: string): MemoryTarget {
  if (!value.startsWith('detail:')) {
    throw new Error(`memory target must start with detail:: ${value}`)
  }
  const body = value.slice('detail:'.length)
  const slash = body.indexOf('/')
  if (slash <= 0 || slash === body.length - 1) {
    throw new Error(`memory target must be detail:<domain>/<file>: ${value}`)
  }
  const domain = assertMemorySegment(body.slice(0, slash), 'domain')
  const rawFile = assertMemorySegment(body.slice(slash + 1), 'file')
  const file = rawFile.endsWith('.json') ? rawFile.slice(0, -'.json'.length) : rawFile
  if (file.length === 0) throw new Error(`memory target has empty file: ${value}`)

  const detailRoot = join(memoryRoot, 'detail')
  const path = assertWithin(detailRoot, join(detailRoot, domain, `${file}.json`), 'memory file')
  return { target: `detail:${domain}/${file}`, domain, file, path }
}

function formatStamp(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
}

function validateEntry(entry: MemoryEntry): void {
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new Error('memory entry needs id')
  }
  if (typeof entry['rec-time'] !== 'string' || entry['rec-time'].length === 0) {
    throw new Error('memory entry needs rec-time')
  }
  if (entry['rev-time'] !== null && typeof entry['rev-time'] !== 'string') {
    throw new Error('memory entry rev-time must be string or null')
  }
  if (entry.at !== null && typeof entry.at !== 'string') {
    throw new Error('memory entry at must be string or null')
  }
  if (!TAGS.has(entry.tag)) throw new Error(`invalid memory tag: ${String(entry.tag)}`)
  if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
    throw new Error('memory entry content is empty')
  }
  for (const quote of entry.quotes ?? []) {
    if (typeof quote.say !== 'string' || quote.say.length === 0) {
      throw new Error('memory quote say is empty')
    }
    if (quote['log-addr'] === undefined) {
      throw new Error('memory quote needs log-addr')
    }
    if (!LOG_ADDR.test(quote['log-addr'])) {
      throw new Error(`invalid memory quote log-addr: ${quote['log-addr']}`)
    }
  }
}

function readDocument(path: string): MemoryDocument | undefined {
  if (!existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryDocument>
  if (!Array.isArray(raw.entries)) throw new Error(`memory file has no entries: ${path}`)
  if (typeof raw.project !== 'string' || typeof raw.filename !== 'string') {
    throw new Error(`memory file has no project/filename: ${path}`)
  }
  return {
    project: raw.project,
    filename: raw.filename,
    introduction: typeof raw.introduction === 'string' ? raw.introduction : '',
    entries: raw.entries as MemoryEntry[],
  }
}

function writeDocument(path: string, doc: MemoryDocument): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

function nextId(doc: MemoryDocument): string {
  const prefix = doc.filename
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`)
  let max = 0
  for (const entry of doc.entries) {
    const match = pattern.exec(entry.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/** 每个 target 一条 Promise 链；不同 target 并行。 */
export class MemoryShardWriter {
  private readonly queues = new Map<string, Promise<unknown>>()

  run<T>(target: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(target) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.queues.set(target, next)
    void next.finally(() => {
      if (this.queues.get(target) === next) this.queues.delete(target)
    }).catch(() => undefined)
    return next
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map(item => item.catch(() => undefined)))
  }
}

export interface MemoryStoreOptions {
  readonly timeZone?: string
  readonly now?: () => Date
  readonly writer?: MemoryShardWriter
  readonly onWrite?: (target: string) => void
}

export class MemoryStore {
  readonly root: string
  readonly timeZone: string
  private readonly now: () => Date
  private readonly writer: MemoryShardWriter
  private readonly onWrite?: (target: string) => void

  constructor(root: string, options: MemoryStoreOptions = {}) {
    this.root = root
    this.timeZone = options.timeZone ?? 'Asia/Shanghai'
    this.now = options.now ?? (() => new Date())
    this.writer = options.writer ?? new MemoryShardWriter()
    if (options.onWrite) this.onWrite = options.onWrite
  }

  target(value: string): MemoryTarget {
    return parseDetailTarget(this.root, value)
  }

  read(value: string): MemoryDocument {
    const target = this.target(value)
    const doc = readDocument(target.path)
    if (!doc) throw new Error(`memory target not found: ${target.target}`)
    return doc
  }

  /** 扫 detail 目录，给 UI 的文件树用；坏文件跳过，读文件时再报。 */
  listDocuments(): MemoryFileSummary[] {
    const detailRoot = join(this.root, 'detail')
    if (!existsSync(detailRoot)) return []
    const out: MemoryFileSummary[] = []
    for (const domain of readdirSync(detailRoot, { withFileTypes: true })) {
      if (!domain.isDirectory() || domain.name.startsWith('_')) continue
      const dir = join(detailRoot, domain.name)
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        const path = join(dir, file.name)
        try {
          const doc = readDocument(path)
          if (!doc) continue
          const stat = statSync(path)
          out.push({
            domain: domain.name,
            project: doc.project,
            filename: doc.filename,
            target: `detail:${domain.name}/${doc.filename}`,
            introduction: doc.introduction,
            entries: doc.entries.length,
            quotes: doc.entries.reduce(
              (sum, entry) => sum + (entry.quotes?.length ?? 0),
              0,
            ),
            bytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
          })
        } catch {
          // 坏文件不阻塞索引。
        }
      }
    }
    return out.sort((a, b) =>
      a.domain.localeCompare(b.domain, 'zh')
      || a.filename.localeCompare(b.filename, 'zh'))
  }

  /** 人类 UI 的整文件保存：同目标串行、跨进程文件锁，校验不过不落盘。 */
  saveDocument(
    value: string,
    doc: MemoryDocument,
  ): Promise<{ document: MemoryDocument; warnings: readonly Issue[] }> {
    const target = this.target(value)
    return this.writer.run(target.path, () => withFileLock(target.path, () => {
      if (doc.filename !== target.file) {
        throw new Error(`memory filename mismatch: ${doc.filename} vs ${target.file}`)
      }
      const result = validateFile(doc)
      if (!result.ok) throw new MemoryValidationError(result)
      const next: MemoryDocument = {
        ...doc,
        project: doc.project.trim() || target.domain,
      }
      writeDocument(target.path, next)
      this.onWrite?.(target.target)
      return { document: next, warnings: result.warnings }
    }, { timeoutMs: 5_000 }))
  }

  search(query: string, limit = 20): MemorySearchHit[] {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return []
    const detailRoot = join(this.root, 'detail')
    if (!existsSync(detailRoot)) return []

    const hits: MemorySearchHit[] = []
    for (const domain of readdirSync(detailRoot, { withFileTypes: true })) {
      if (!domain.isDirectory() || domain.name.startsWith('_')) continue
      const domainDir = join(detailRoot, domain.name)
      for (const file of readdirSync(domainDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        let doc: MemoryDocument | undefined
        try {
          doc = readDocument(join(domainDir, file.name))
        } catch {
          continue
        }
        if (!doc) continue
        for (const entry of doc.entries) {
          const haystack = [
            entry.id,
            entry.content,
            ...(entry.quotes ?? []).map(quote => quote.say),
          ].join('\n').toLowerCase()
          if (!haystack.includes(needle)) continue
          hits.push({
            target: `detail:${domain.name}/${doc.filename}`,
            id: entry.id,
            tag: entry.tag,
            preview: entry.content.length > 240
              ? `${entry.content.slice(0, 240)}…`
              : entry.content,
            filename: doc.filename,
          })
          if (hits.length >= limit) return hits
        }
      }
    }
    return hits
  }

  add(value: string, input: MemoryAddInput): Promise<MemoryEntry> {
    const target = this.target(value)
    return this.writer.run(target.path, () => withFileLock(target.path, () => {
      const existing = readDocument(target.path)
      const doc: MemoryDocument = existing ?? {
        project: target.domain,
        filename: target.file,
        introduction: input.introduction ?? '',
        entries: [],
      }
      if (!existing && (input.introduction ?? '').trim().length === 0) {
        throw new Error('new memory target needs introduction')
      }
      const entry: MemoryEntry = {
        id: nextId(doc),
        'rec-time': formatStamp(this.now(), this.timeZone),
        'rev-time': null,
        at: input.at ?? null,
        tag: input.tag,
        content: input.content,
        ...(input.quotes ? { quotes: input.quotes } : {}),
      }
      validateEntry(entry)
      writeDocument(target.path, {
        ...doc,
        entries: [...doc.entries, entry],
      })
      this.onWrite?.(target.target)
      return entry
    }, { timeoutMs: 5_000 }))
  }

  update(value: string, id: string, patch: MemoryUpdateInput): Promise<MemoryEntry> {
    const target = this.target(value)
    return this.writer.run(target.path, () => withFileLock(target.path, () => {
      const doc = readDocument(target.path)
      if (!doc) throw new Error(`memory target not found: ${target.target}`)
      const index = doc.entries.findIndex(entry => entry.id === id)
      if (index < 0) throw new Error(`memory entry not found: ${target.target}#${id}`)
      const current = doc.entries[index]!
      if (
        patch.expectedRevTime !== undefined
        && current['rev-time'] !== patch.expectedRevTime
      ) {
        throw new Error(`memory entry changed: ${target.target}#${id}`)
      }
      const next: MemoryEntry = {
        ...current,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.tag !== undefined ? { tag: patch.tag } : {}),
        ...(patch.at !== undefined ? { at: patch.at } : {}),
        ...(patch.quotes !== undefined ? { quotes: patch.quotes } : {}),
        'rev-time': formatStamp(this.now(), this.timeZone),
      }
      validateEntry(next)
      const entries = [...doc.entries]
      entries[index] = next
      writeDocument(target.path, { ...doc, entries })
      this.onWrite?.(target.target)
      return next
    }, { timeoutMs: 5_000 }))
  }

  async flush(): Promise<void> {
    await this.writer.flush()
  }
}
