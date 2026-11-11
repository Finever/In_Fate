/**
 * 记忆条目摘要：给选择器/展示用的生成式摘要，不替代 detail。
 *
 * 摘要由模型生成，写在 summaries/<namespace>/<file>.json；没有模型时
 * 不偷偷退回抽取式，选择器直接用正文。摘要是派生缓存，不是记忆真相。
 *
 * @module if/memory/summary
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { assertWithin } from '../core/safe-path.ts'
import type { MemoryEntry, MemoryFileSummary, MemoryStore } from './store.ts'

export interface MemoryEntrySummary {
  readonly target: string
  readonly entryId: string
  readonly title: string
  readonly summary: string
  readonly keywords: readonly string[]
  readonly tag: '确信' | '可信' | '有疑'
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
  readonly generator?: string
  /** 生成摘要时 detail 的内容指纹；指纹不变就不重复摘要。 */
  readonly sourceDigest: string
  readonly entries: readonly MemoryEntrySummary[]
}

export interface GeneratedEntrySummary {
  readonly entryId: string
  readonly title: string
  readonly summary: string
  readonly keywords?: readonly string[]
}

export interface MemorySummaryGenerator {
  readonly name: string
  generateDocument(input: {
    readonly target: string
    readonly entries: readonly MemoryEntry[]
    readonly now: Date
  }): Promise<readonly GeneratedEntrySummary[]>
}

export interface MemorySummaryStoreOptions {
  readonly root: string
  readonly store: MemoryStore
  readonly now?: () => Date
  readonly generator?: MemorySummaryGenerator
  readonly onWrite?: (target: string) => void
}

function digestOf(entry: MemoryEntry): string {
  return createHash('sha1')
    .update(`${entry.content}\n${(entry.quotes ?? []).map(quote => quote.say).join('\n')}`)
    .digest('hex')
}

function sourceDigestOf(entries: readonly MemoryEntry[]): string {
  return createHash('sha1')
    .update(entries.map(entry => `${entry.id}\n${digestOf(entry)}`).join('\n'))
    .digest('hex')
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

export class MemorySummaryStore {
  readonly root: string
  readonly store: MemoryStore
  private readonly now: () => Date
  private readonly generator?: MemorySummaryGenerator
  private readonly onWrite?: (target: string) => void

  constructor(options: MemorySummaryStoreOptions) {
    this.root = options.root
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.generator = options.generator
    if (options.onWrite) this.onWrite = options.onWrite
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

  hasGenerator(): boolean {
    return Boolean(this.generator)
  }

  /** 当前 detail 的内容指纹；和摘要文件里的 sourceDigest 比。 */
  sourceDigest(target: string): string {
    return sourceDigestOf(this.store.read(target).entries)
  }

  needsUpdate(target: string): boolean {
    const existing = this.read(target)
    if (!existing) return true
    if (this.generator && existing.generator !== this.generator.name) return true
    try {
      return existing.sourceDigest !== this.sourceDigest(target)
    } catch {
      return true
    }
  }

  read(target: string): MemorySummaryDocument | undefined {
    const path = this.pathFor(target)
    if (!existsSync(path)) return undefined
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as MemorySummaryDocument
      if (
        raw.version !== 1
        || raw.target !== target
        || !Array.isArray(raw.entries)
        || typeof raw.generator !== 'string'
        || raw.generator.length === 0
        || typeof raw.sourceDigest !== 'string'
      ) return undefined
      return raw
    } catch {
      return undefined
    }
  }

  /** 显式重建用；没有配置模型时直接报错，不退回抽取。 */
  async generate(target: string): Promise<MemorySummaryDocument> {
    if (!this.generator) throw new Error('memory summary generator is not configured')
    const doc = this.store.read(target)
    const parsed = this.store.target(target)
    const generated = await this.generator.generateDocument({
      target,
      entries: doc.entries,
      now: this.now(),
    })
    const byId = new Map(generated.map(item => [item.entryId, item]))
    const entries: MemoryEntrySummary[] = []
    for (const entry of doc.entries) {
      const summary = byId.get(entry.id)
      if (!summary) continue
      entries.push({
        target,
        entryId: entry.id,
        title: cleanText(summary.title, 80) || entry.id,
        summary: cleanText(summary.summary, 600),
        keywords: (summary.keywords ?? [])
          .filter((word): word is string => typeof word === 'string')
          .map(word => word.trim())
          .filter(Boolean)
          .slice(0, 12),
        tag: entry.tag,
        bytes: Buffer.byteLength(entry.content, 'utf8'),
        digest: digestOf(entry),
      })
    }
    if (entries.length === 0) throw new Error(`summary generator returned no entries: ${target}`)
    const path = this.pathFor(target)
    const summary: MemorySummaryDocument = {
      version: 1,
      target,
      filename: parsed.file,
      domain: parsed.domain,
      namespace: parsed.namespace,
      generatedAt: this.now().toISOString(),
      generator: this.generator.name,
      sourceDigest: sourceDigestOf(doc.entries),
      entries,
    }
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
    this.onWrite?.(target)
    return summary
  }

  /** 只在摘要比 detail 新时复用；不会在 renderContext 里被调用。 */
  async ensure(target: string): Promise<MemorySummaryDocument | undefined> {
    if (!this.needsUpdate(target)) return this.read(target)
    if (!this.generator) return undefined
    return this.generate(target)
  }

  /** 清掉已经不存在/已移走的 detail 对应的孤儿摘要。 */
  prune(validTargets: ReadonlySet<string>): void {
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as { target?: unknown }
          if (typeof raw.target === 'string' && !validTargets.has(raw.target)) rmSync(path)
        } catch {
          // 坏摘要不阻塞清理。
        }
      }
    }
    walk(join(this.root, 'summaries'))
  }

  /** 删除 detail 对应的摘要缓存。 */
  remove(target: string): void {
    const path = this.pathFor(target)
    try {
      if (existsSync(path)) rmSync(path)
    } catch {
      // 缓存删除失败不阻塞主流程。
    }
  }

  /** detail 移动/改名时搬摘要，避免留下孤儿文件。 */
  move(from: string, to: string): void {
    const sourcePath = this.pathFor(from)
    if (!existsSync(sourcePath)) return
    const target = this.store.target(to)
    try {
      const raw = JSON.parse(readFileSync(sourcePath, 'utf8')) as MemorySummaryDocument
      const next: MemorySummaryDocument = {
        ...raw,
        target: to,
        filename: target.file,
        domain: target.domain,
        namespace: target.namespace,
        entries: raw.entries.map(entry => ({ ...entry, target: to })),
      }
      const destination = this.pathFor(to)
      mkdirSync(dirname(destination), { recursive: true })
      const temp = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(temp, destination)
      rmSync(sourcePath, { force: true })
    } catch {
      // 摘要搬移失败时删旧缓存；新目标会进后台队列。
      this.remove(from)
    }
  }

  async ensureAll(targets?: readonly string[]): Promise<MemorySummaryDocument[]> {
    if (!this.generator) throw new Error('memory summary generator is not configured')
    const list = targets ?? this.store.listDocuments({
      includePrivate: false,
      includeInvalid: false,
    }).map(item => item.target)
    const out: MemorySummaryDocument[] = []
    for (const target of list) {
      try {
        const summary = await this.ensure(target)
        if (summary) out.push(summary)
      } catch {
        // 单个文件失败不阻塞其它摘要；调用方可看旧缓存。
      }
    }
    return out
  }
}

/** 供 UI/调试用：摘要文件的稳定短标签。 */
export function summaryTargets(files: readonly MemoryFileSummary[]): string[] {
  return files.map(file => file.target)
}
