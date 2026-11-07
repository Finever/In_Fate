/**
 * 记忆条目摘要：给选择器用的轻量索引，不替代 detail。
 *
 * 摘要是派生物，写在 summaries/<namespace>/<file>.json；detail 变了就重算。
 * 默认 extractive；以后可以换成 Jev / 本地模型生成，接口保持不变。
 *
 * @module if/memory/summary
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { assertWithin } from '../core/safe-path.ts'
import type {
  MemoryEntry,
  MemoryFileSummary,
  MemoryStore,
  MemoryTag,
} from './store.ts'

export interface MemoryEntrySummary {
  readonly target: string
  readonly entryId: string
  readonly title: string
  readonly summary: string
  readonly keywords: readonly string[]
  readonly tag: MemoryTag
  readonly bytes: number
  readonly digest: string
}

export interface MemorySummaryDocument {
  readonly version: 1
  readonly target: string
  readonly filename: string
  readonly domain: string
  readonly namespace: string
  readonly generatedAt: string
  readonly entries: readonly MemoryEntrySummary[]
}

export interface MemorySummaryGenerator {
  generate(input: {
    readonly target: string
    readonly entry: MemoryEntry
    readonly now: Date
  }): MemoryEntrySummary
}

export interface MemorySummaryStoreOptions {
  readonly root: string
  readonly store: MemoryStore
  readonly now?: () => Date
  readonly generator?: MemorySummaryGenerator
  readonly onWrite?: (target: string) => void
}

const MAX_SUMMARY_CHARS = 220
const MAX_KEYWORDS = 12

function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleOf(text: string): string {
  const line = text.split('\n').map(line => line.trim()).find(Boolean) ?? ''
  return plain(line).slice(0, 48) || '（无标题）'
}

function summaryOf(text: string): string {
  const value = plain(text)
  if (value.length <= MAX_SUMMARY_CHARS) return value
  return `${value.slice(0, MAX_SUMMARY_CHARS)}…`
}

function keywordsOf(text: string): string[] {
  const words = text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_]{2,}/gu) ?? []
  const stop = new Set([
    '这个', '那个', '我们', '你们', '他们', '自己', '因为', '所以', '如果',
    '但是', '然后', '已经', '可以', '没有', '不是', '就是', '一个', '什么',
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'will',
  ])
  const seen = new Set<string>()
  const out: string[] = []
  for (const word of words) {
    const key = word.toLowerCase()
    if (stop.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

function digestOf(entry: MemoryEntry): string {
  return createHash('sha1')
    .update(`${entry.content}\n${(entry.quotes ?? []).map(quote => quote.say).join('\n')}`)
    .digest('hex')
}

export class ExtractiveSummaryGenerator implements MemorySummaryGenerator {
  generate(input: { readonly target: string; readonly entry: MemoryEntry; readonly now: Date }): MemoryEntrySummary {
    const text = [
      input.entry.content,
      ...(input.entry.quotes ?? []).map(quote => quote.say),
    ].join('\n')
    return {
      target: input.target,
      entryId: input.entry.id,
      title: titleOf(input.entry.content),
      summary: summaryOf(text),
      keywords: keywordsOf(text),
      tag: input.entry.tag,
      bytes: Buffer.byteLength(input.entry.content, 'utf8'),
      digest: digestOf(input.entry),
    }
  }
}

export class MemorySummaryStore {
  readonly root: string
  readonly store: MemoryStore
  private readonly now: () => Date
  private readonly generator: MemorySummaryGenerator
  private readonly onWrite?: (target: string) => void

  constructor(options: MemorySummaryStoreOptions) {
    this.root = options.root
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.generator = options.generator ?? new ExtractiveSummaryGenerator()
    this.onWrite = options.onWrite
  }

  pathFor(target: string): string {
    const parsed = this.store.target(target)
    const path = join(
      this.root,
      'summaries',
      ...parsed.namespace.split('/'),
      `${parsed.file}.json`,
    )
    return assertWithin(this.root, path, 'memory summary path')
  }

  read(target: string): MemorySummaryDocument | undefined {
    const path = this.pathFor(target)
    if (!existsSync(path)) return undefined
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as MemorySummaryDocument
      if (raw.version !== 1 || raw.target !== target || !Array.isArray(raw.entries)) return undefined
      return raw
    } catch {
      return undefined
    }
  }

  /** 同步生成；选择器在 renderContext 里调用，因此不能异步。 */
  ensure(target: string): MemorySummaryDocument {
    const path = this.pathFor(target)
    const detailPath = this.store.target(target).path
    if (existsSync(path) && existsSync(detailPath)) {
      const summaryStat = statSync(path)
      const detailStat = statSync(detailPath)
      if (summaryStat.mtimeMs >= detailStat.mtimeMs) {
        const existing = this.read(target)
        if (existing) return existing
      }
    }
    return this.generate(target)
  }

  ensureAll(targets?: readonly string[]): MemorySummaryDocument[] {
    const list = targets ?? this.store.listDocuments({
      includePrivate: false,
      includeInvalid: false,
    }).map(item => item.target)
    const out: MemorySummaryDocument[] = []
    for (const target of list) {
      try {
        out.push(this.ensure(target))
      } catch {
        // 坏文件不阻塞选择器。
      }
    }
    return out
  }

  generate(target: string): MemorySummaryDocument {
    const doc = this.store.read(target)
    const parsed = this.store.target(target)
    const path = this.pathFor(target)
    const summary: MemorySummaryDocument = {
      version: 1,
      target,
      filename: parsed.file,
      domain: parsed.domain,
      namespace: parsed.namespace,
      generatedAt: this.now().toISOString(),
      entries: doc.entries.map(entry =>
        this.generator.generate({ target, entry, now: this.now() })),
    }
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
    this.onWrite?.(target)
    return summary
  }
}

/** 供 UI/调试用：摘要文件的稳定短标签。 */
export function summaryTargets(files: readonly MemoryFileSummary[]): string[] {
  return files.map(file => file.target)
}
