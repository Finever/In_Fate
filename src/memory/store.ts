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
  lstatSync,
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
  /** 保留未知顶层字段，避免编辑器保存时静默丢数据。 */
  readonly [key: string]: unknown
}

export interface MemoryTarget {
  readonly target: string
  /** 顶层目录，沿用 project 的语义。 */
  readonly domain: string
  /** 完整相对目录，可含多层，例如 `_private/us`。 */
  readonly namespace: string
  readonly file: string
  readonly path: string
  readonly private: boolean
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

export interface MemoryListOptions {
  /** 是否把任意一段以 `_` 开头的私域也列出来；共享检索默认 false。 */
  readonly includePrivate?: boolean
  /** 是否把解析失败/filename 不一致的文件也列出来；给编辑器修复用。 */
  readonly includeInvalid?: boolean
}

export interface MemoryFileSummary {
  /** 顶层目录，保持旧字段语义。 */
  readonly domain: string
  /** 完整相对目录，例如 `_private/us`。 */
  readonly namespace?: string
  readonly project: string
  readonly filename: string
  readonly target: string
  readonly introduction: string
  readonly entries: number
  readonly quotes: number
  readonly bytes: number
  readonly updatedAt: string
  readonly private?: boolean
  readonly invalid?: string
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

const PROTECTED_DIRS = new Set(['_trash', '_archive'])

/** 系统件/回收站/点目录不进入普通记忆 target。 */
export function isProtectedMemorySegment(value: string): boolean {
  return value.startsWith('.') || PROTECTED_DIRS.has(value)
}

function assertMemorySegment(value: string, label: string): string {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || BAD_SEGMENT.test(value)
    || /[. ]$/.test(value)
    || RESERVED.test(value)
    || isProtectedMemorySegment(value)
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
  const parts = body.split('/')
  const rawFile = parts.pop()
  if (!rawFile || parts.length === 0) {
    throw new Error(`memory target must be detail:<dir>/<file>: ${value}`)
  }
  const namespaceParts = parts.map((part, index) =>
    assertMemorySegment(part, index === 0 ? 'domain' : 'namespace'))
  const rawFileName = assertMemorySegment(rawFile, 'file')
  const file = rawFileName.endsWith('.json')
    ? rawFileName.slice(0, -'.json'.length)
    : rawFileName
  if (file.length === 0 || file === 'indexlist') {
    throw new Error(`memory target has protected/empty file: ${value}`)
  }

  const namespace = namespaceParts.join('/')
  const domain = namespaceParts[0]!
  const privateTarget = namespaceParts.some(part => part.startsWith('_'))
  const detailRoot = join(memoryRoot, 'detail')
  const path = assertWithin(
    detailRoot,
    join(detailRoot, ...namespaceParts, `${file}.json`),
    'memory file',
  )
  return {
    target: `detail:${namespace}/${file}`,
    domain,
    namespace,
    file,
    path,
    private: privateTarget,
  }
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
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`memory file symlink is not allowed: ${path}`)
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (!Array.isArray(raw.entries)) throw new Error(`memory file has no entries: ${path}`)
  if (typeof raw.project !== 'string' || typeof raw.filename !== 'string') {
    throw new Error(`memory file has no project/filename: ${path}`)
  }
  return {
    ...raw,
    project: raw.project,
    filename: raw.filename,
    introduction: typeof raw.introduction === 'string' ? raw.introduction : '',
    entries: raw.entries as MemoryEntry[],
  }
}

function writeDocument(path: string, doc: MemoryDocument): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`memory file symlink is not allowed: ${path}`)
  }
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

interface DetailFileRef {
  readonly path: string
  readonly namespace: string
  readonly stem: string
  readonly private: boolean
}

function collectDetailFiles(
  detailRoot: string,
  options: MemoryListOptions,
  out: DetailFileRef[] = [],
  segments: readonly string[] = [],
): DetailFileRef[] {
  let entries
  try {
    entries = readdirSync(
      segments.length === 0 ? detailRoot : join(detailRoot, ...segments),
      { withFileTypes: true },
    )
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || PROTECTED_DIRS.has(entry.name)) continue
    if (entry.isDirectory()) {
      collectDetailFiles(detailRoot, options, out, [...segments, entry.name])
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    if (entry.name === 'indexlist.json' || segments.length === 0) continue
    const stem = entry.name.slice(0, -'.json'.length)
    if (!stem || stem === 'indexlist') continue
    const isPrivate = segments.some(part => part.startsWith('_'))
    if (isPrivate && !options.includePrivate) continue
    out.push({
      path: join(detailRoot, ...segments, entry.name),
      namespace: segments.join('/'),
      stem,
      private: isPrivate,
    })
  }
  return out
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
  /** 与 MemoryLibrary 共用的库级锁；所有 detail 写入先拿它，再拿 target 锁。 */
  readonly libraryLock?: string
}

export class MemoryStore {
  readonly root: string
  readonly timeZone: string
  private readonly now: () => Date
  private readonly writer: MemoryShardWriter
  private readonly onWrite?: (target: string) => void
  private readonly libraryLock?: string

  constructor(root: string, options: MemoryStoreOptions = {}) {
    this.root = root
    this.timeZone = options.timeZone ?? 'Asia/Shanghai'
    this.now = options.now ?? (() => new Date())
    this.writer = options.writer ?? new MemoryShardWriter()
    this.libraryLock = options.libraryLock
    if (options.onWrite) this.onWrite = options.onWrite
  }

  /** 所有 detail 写入都先过库级锁；锁顺序固定为 library → target。 */
  private withLibrary<T>(task: () => Promise<T>): Promise<T> {
    if (!this.libraryLock) return task()
    mkdirSync(dirname(this.libraryLock), { recursive: true })
    return withFileLock(this.libraryLock, task, { timeoutMs: 15_000 })
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

  /**
   * 扫 detail 目录，给 UI/索引用。
   *
   * 默认只列共享域且跳过坏文件；编辑器传 includePrivate/includeInvalid，
   * 才能在树里看到 `_private` 和需要修复的文件。
   */
  listDocuments(options: MemoryListOptions = {}): MemoryFileSummary[] {
    const detailRoot = join(this.root, 'detail')
    if (!existsSync(detailRoot)) return []
    const files = collectDetailFiles(detailRoot, options)
    const out: MemoryFileSummary[] = []
    for (const file of files) {
      let doc: MemoryDocument | undefined
      let invalid: string | undefined
      try {
        doc = readDocument(file.path)
        if (!doc) invalid = 'file disappeared'
        else if (doc.filename !== file.stem) {
          invalid = `filename mismatch: ${doc.filename} vs ${file.stem}`
        }
      } catch (error) {
        invalid = error instanceof Error ? error.message : String(error)
      }
      if (invalid && !options.includeInvalid) continue
      let stat
      try {
        stat = statSync(file.path)
      } catch {
        continue
      }
      const entries = doc?.entries ?? []
      out.push({
        domain: file.namespace.split('/')[0] ?? '',
        namespace: file.namespace,
        project: doc?.project ?? '',
        filename: file.stem,
        target: `detail:${file.namespace}/${file.stem}`,
        introduction: doc?.introduction ?? '',
        entries: entries.length,
        quotes: entries.reduce(
          (sum, entry) => sum + (entry.quotes?.length ?? 0),
          0,
        ),
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        ...(file.private ? { private: true } : {}),
        ...(invalid ? { invalid } : {}),
      })
    }
    return out.sort((a, b) =>
      (a.namespace ?? a.domain).localeCompare(b.namespace ?? b.domain, 'zh')
      || a.filename.localeCompare(b.filename, 'zh'))
  }

  /** 人类 UI 的整文件保存：同目标串行、跨进程文件锁，校验不过不落盘。 */
  saveDocument(
    value: string,
    doc: MemoryDocument,
  ): Promise<{ document: MemoryDocument; warnings: readonly Issue[] }> {
    const target = this.target(value)
    return this.withLibrary(() => this.writer.run(target.path, () => withFileLock(target.path, () => {
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
    }, { timeoutMs: 5_000 })))
  }

  search(query: string, limit = 20, options: MemoryListOptions = {}): MemorySearchHit[] {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return []
    const hits: MemorySearchHit[] = []
    for (const summary of this.listDocuments({
      includePrivate: options.includePrivate === true,
      includeInvalid: false,
    })) {
      let doc: MemoryDocument
      try {
        doc = this.read(summary.target)
      } catch {
        continue
      }
      for (const entry of doc.entries) {
        const haystack = [
          entry.id,
          entry.content,
          ...(entry.quotes ?? []).map(quote => quote.say),
        ].join('\n').toLowerCase()
        if (!haystack.includes(needle)) continue
        hits.push({
          target: summary.target,
          id: entry.id,
          tag: entry.tag,
          preview: entry.content.length > 240
            ? `${entry.content.slice(0, 240)}…`
            : entry.content,
          filename: summary.filename,
        })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }

  add(value: string, input: MemoryAddInput): Promise<MemoryEntry> {
    const target = this.target(value)
    mkdirSync(dirname(target.path), { recursive: true })
    return this.withLibrary(() => this.writer.run(target.path, () => withFileLock(target.path, () => {
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
    }, { timeoutMs: 5_000 })))
  }

  update(value: string, id: string, patch: MemoryUpdateInput): Promise<MemoryEntry> {
    const target = this.target(value)
    return this.withLibrary(() => this.writer.run(target.path, () => withFileLock(target.path, () => {
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
    }, { timeoutMs: 5_000 })))
  }

  async flush(): Promise<void> {
    await this.writer.flush()
  }
}
