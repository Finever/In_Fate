import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  nextId,
  orderEntry,
  orderFile,
  orderQuote,
  type Entry,
  type MemoryFile,
  type Quote,
} from './entry.ts'
import { validateFile, type Issue } from './validate.ts'

export class MemoryWriteError extends Error {
  readonly issues: readonly Issue[]

  constructor(message: string, issues: readonly Issue[] = []) {
    super(message)
    this.name = 'MemoryWriteError'
    this.issues = issues
  }
}

export interface AppendOptions {
  /** 缺 log-addr 时是否拒绝写入。默认 true。 */
  readonly requireQuoteAddress?: boolean
}

export interface AppendResult {
  readonly file: MemoryFile
  readonly added: readonly Entry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeQuote(raw: Record<string, unknown>): Quote {
  return orderQuote(raw as unknown as Quote)
}

function normalizeEntry(raw: Record<string, unknown>, id: string): Entry {
  const quotes = Array.isArray(raw.quotes)
    ? raw.quotes.map(item => (isRecord(item) ? normalizeQuote(item) : item))
    : []

  return orderEntry({
    id,
    'rec-time': raw['rec-time'],
    'rev-time': raw['rev-time'] ?? null,
    at: raw.at ?? null,
    tag: raw.tag,
    content: raw.content,
    quotes,
  })
}

/**
 * 在内存里追加条目，不落盘。用于测试和批量构建。
 * 新条目先校验；不过就抛 MemoryWriteError，原文件不动。
 */
export function appendEntries(
  doc: MemoryFile,
  inputs: readonly Record<string, unknown>[],
  options: AppendOptions = {},
): AppendResult {
  let working: Entry[] = [...doc.entries]
  const added: Entry[] = []

  for (const raw of inputs) {
    const requested = raw.id
    const id = requested === undefined || requested === '' || requested === 'auto'
      ? nextId(doc.filename, working)
      : String(requested)

    if (working.some(entry => entry.id === id)) {
      throw new MemoryWriteError(`id 重复：${id}`)
    }

    const entry = normalizeEntry(raw, id)
    working = [...working, entry]
    added.push(entry)
  }

  if (added.length === 0) return { file: doc, added }

  // 只校验新增的这一批，历史不重新审判。
  const draft: MemoryFile = {
    project: doc.project,
    filename: doc.filename,
    introduction: doc.introduction,
    entries: added,
  }
  const result = validateFile(draft, {
    requireQuoteAddress: options.requireQuoteAddress ?? true,
  })
  if (!result.ok) {
    throw new MemoryWriteError('新条目校验失败', result.errors)
  }

  return { file: { ...doc, entries: working }, added }
}

/** 序列化并写盘。固定 indent 4、末尾换行、UTF-8、LF。 */
export function writeMemoryFile(path: string, doc: MemoryFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(orderFile(doc), null, 4) + '\n', 'utf8')
}

export function loadMemoryFile(path: string): MemoryFile {
  if (!existsSync(path)) throw new MemoryWriteError(`文件不存在：${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as MemoryFile
}

/** 读文件 → 追加 → 校验 → 写回。一步到位。 */
export function appendToFile(
  path: string,
  inputs: readonly Record<string, unknown>[],
  options: AppendOptions = {},
): AppendResult {
  const doc = loadMemoryFile(path)
  const result = appendEntries(doc, inputs, options)
  writeMemoryFile(path, result.file)
  return result
}
