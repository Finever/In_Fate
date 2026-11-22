/**
 * Jev 选择器的契约与轻量本地实现。
 *
 * 选择器直接按正文/原话打分；模型生成的摘要只是加分项和展示文本，
 * 缺失时仍能选择，不会退回抽取式摘要。
 *
 * @module if/memory/selector
 */

import { createHash } from 'node:crypto'
import type { HistoryMessage } from '../projections/history.ts'
import type { ResolvedMemoryPolicy } from './policy.ts'
import type { MemoryEntry, MemoryStore, MemoryTag } from './store.ts'
import { MemorySummaryStore, type MemorySummaryDocument, type MemoryEntrySummary } from './summary.ts'

export interface MemorySelectionInput {
  readonly sessionId: string
  readonly history: readonly HistoryMessage[]
  readonly policy: ResolvedMemoryPolicy
}

export interface MemoryPacketEntry {
  readonly target: string
  readonly entryId: string
  readonly tag: MemoryTag
  readonly title: string
  readonly summary: string
  readonly content: string
  readonly score: number
}

export interface MemoryPacket {
  readonly id: string
  readonly sessionId: string
  readonly generatedAt: string
  readonly query: string
  readonly entries: readonly MemoryPacketEntry[]
  readonly bytes: number
  readonly strategy: string
}

export interface MemorySelector {
  select(input: MemorySelectionInput): MemoryPacket | undefined
}

export interface HeuristicMemorySelectorOptions {
  readonly store: MemoryStore
  readonly summaries: MemorySummaryStore
  readonly now?: () => Date
  /**
   * 该会话可自动推送的私域目录名（如 `_weiliang`）；不配 = 只推共享域。
   * 私域 autoPush 只对 owner agent 的 steward 会话开，由空间 ACL 决定。
   */
  readonly autoPushDirsFor?: (sessionId: string) => readonly string[]
}

function namespaceInDirs(namespace: string, dirs: readonly string[]): boolean {
  return dirs.some(dir => namespace === dir || namespace.startsWith(`${dir}/`))
}

const TAG_WEIGHT: Record<MemoryTag, number> = { 确信: 3, 可信: 2, 有疑: 1 }
const MAX_CONTENT_CHARS = 1_200

function textOf(message: HistoryMessage): string {
  const content = message.content
  const text = typeof content === 'string'
    ? content
    : content.map(block => block.type === 'text' ? block.text : '').join(' ')
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
}

function queryOf(history: readonly HistoryMessage[]): string {
  return history
    .slice(-6)
    .map(textOf)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{Script=Han}]{2,}|[a-z0-9_]{2,}/gu) ?? []
}

function entrySummary(
  summary: MemorySummaryDocument | undefined,
  entry: MemoryEntry,
): MemoryEntrySummary | undefined {
  return summary?.entries.find(item => item.entryId === entry.id)
}

function scoreEntry(
  entry: MemoryEntry,
  cached: MemoryEntrySummary | undefined,
  query: string,
  queryTerms: readonly string[],
): number {
  const haystack = [
    entry.content,
    ...(entry.quotes ?? []).map(quote => quote.say),
    cached?.title ?? '',
    cached?.summary ?? '',
    cached?.keywords.join(' ') ?? '',
  ].join('\n').toLowerCase()
  let score = TAG_WEIGHT[entry.tag]
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 4
  }
  if (query && haystack.includes(query.toLowerCase())) score += 3
  return score
}

function scopeAllows(
  target: string,
  domain: string,
  policy: ResolvedMemoryPolicy,
): boolean {
  const scope = policy.jev.scope ?? policy.scope
  const value = policy.jev.scopeValue ?? policy.scopeValue
  if (!value) return true
  if (scope === 'target') {
    return target === value || target.startsWith(`${value}#`)
  }
  if (scope === 'domain') {
    return target === value
      || target.startsWith(`detail:${value}/`)
      || domain === value
  }
  return true
}

export class HeuristicMemorySelector implements MemorySelector {
  private readonly store: MemoryStore
  private readonly summaries: MemorySummaryStore
  private readonly now: () => Date
  private readonly autoPushDirsFor?: (sessionId: string) => readonly string[]

  constructor(options: HeuristicMemorySelectorOptions) {
    this.store = options.store
    this.summaries = options.summaries
    this.now = options.now ?? (() => new Date())
    if (options.autoPushDirsFor) this.autoPushDirsFor = options.autoPushDirsFor
  }

  select(input: MemorySelectionInput): MemoryPacket | undefined {
    const query = queryOf(input.history)
    const queryTerms = termsOf(query)
    const maxEntries = Math.max(1, input.policy.maxEntries)
    const maxBytes = Math.max(512, input.policy.maxBytes)
    const autoPushDirs = this.autoPushDirsFor?.(input.sessionId) ?? []

    const candidates: {
      target: string
      entry: MemoryEntry
      cached?: MemoryEntrySummary
      score: number
    }[] = []
    for (const file of this.store.listDocuments({ includePrivate: true, includeInvalid: false })) {
      if (file.private && !namespaceInDirs(file.namespace ?? file.domain, autoPushDirs)) continue
      if (!scopeAllows(file.target, file.domain, input.policy)) continue
      let doc
      try {
        doc = this.store.read(file.target)
      } catch {
        continue
      }
      const summary = this.summaries.read(file.target)
      for (const entry of doc.entries) {
        const cached = entrySummary(summary, entry)
        candidates.push({
          target: file.target,
          entry,
          ...(cached ? { cached } : {}),
          score: scoreEntry(entry, cached, query, queryTerms),
        })
      }
    }
    candidates.sort((a, b) =>
      b.score - a.score
      || a.target.localeCompare(b.target, 'zh')
      || a.entry.id.localeCompare(b.entry.id, 'zh'))
    if (candidates.length === 0) return undefined

    const entries: MemoryPacketEntry[] = []
    let bytes = 0
    for (const candidate of candidates) {
      if (entries.length >= maxEntries) break
      const content = candidate.entry.content.slice(0, MAX_CONTENT_CHARS)
      const packetEntry: MemoryPacketEntry = {
        target: candidate.target,
        entryId: candidate.entry.id,
        tag: candidate.entry.tag,
        title: candidate.cached?.title ?? candidate.entry.id,
        summary: candidate.cached?.summary ?? '',
        content,
        score: candidate.score,
      }
      const size = Buffer.byteLength(JSON.stringify(packetEntry), 'utf8')
      if (entries.length > 0 && bytes + size > maxBytes) break
      entries.push(packetEntry)
      bytes += size
    }
    if (entries.length === 0) return undefined
    return {
      id: createHash('sha1')
        .update(entries.map(entry => `${entry.target}#${entry.entryId}`).join('\n'))
        .digest('hex')
        .slice(0, 16),
      sessionId: input.sessionId,
      generatedAt: this.now().toISOString(),
      query,
      entries,
      bytes,
      strategy: 'heuristic-local',
    }
  }
}
