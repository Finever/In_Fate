/**
 * Jev 选择器的契约与轻量本地实现。
 *
 * 选择器只负责“从共享记忆里挑几条”，不负责推理；后续可以换成
 * Jev 小模型或外部 selector，只要实现 MemorySelector。
 *
 * @module if/memory/selector
 */

import { createHash } from 'node:crypto'
import type { HistoryMessage } from '../projections/history.ts'
import type { ResolvedMemoryPolicy } from './policy.ts'
import type { MemoryTag, MemoryStore } from './store.ts'
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

function scoreEntry(
  summary: MemoryEntrySummary,
  query: string,
  queryTerms: readonly string[],
): number {
  let score = TAG_WEIGHT[summary.tag]
  const haystack = `${summary.title}\n${summary.summary}\n${summary.keywords.join(' ')}`.toLowerCase()
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 4
  }
  if (query && haystack.includes(query.toLowerCase())) score += 3
  return score
}

function scopeAllows(
  summary: MemorySummaryDocument,
  policy: ResolvedMemoryPolicy,
): boolean {
  const scope = policy.jev.scope ?? policy.scope
  const value = policy.jev.scopeValue ?? policy.scopeValue
  if (!value) return true
  if (scope === 'target') {
    return summary.target === value || summary.target.startsWith(`${value}#`)
  }
  if (scope === 'domain') {
    return summary.domain === value || summary.namespace === value
      || summary.namespace.startsWith(`${value}/`)
  }
  return true
}

export class HeuristicMemorySelector implements MemorySelector {
  private readonly store: MemoryStore
  private readonly summaries: MemorySummaryStore
  private readonly now: () => Date

  constructor(options: HeuristicMemorySelectorOptions) {
    this.store = options.store
    this.summaries = options.summaries
    this.now = options.now ?? (() => new Date())
  }

  select(input: MemorySelectionInput): MemoryPacket | undefined {
    const query = queryOf(input.history)
    const queryTerms = termsOf(query)
    const maxEntries = Math.max(1, input.policy.maxEntries)
    const maxBytes = Math.max(512, input.policy.maxBytes)

    const candidates: {
      summary: MemorySummaryDocument
      entry: MemoryEntrySummary
      score: number
    }[] = []
    for (const summary of this.summaries.ensureAll()) {
      if (!scopeAllows(summary, input.policy)) continue
      for (const entry of summary.entries) {
        candidates.push({
          summary,
          entry,
          score: scoreEntry(entry, query, queryTerms),
        })
      }
    }
    candidates.sort((a, b) =>
      b.score - a.score
      || a.summary.target.localeCompare(b.summary.target, 'zh')
      || a.entry.entryId.localeCompare(b.entry.entryId, 'zh'))
    if (candidates.length === 0) return undefined

    const entries: MemoryPacketEntry[] = []
    let bytes = 0
    for (const candidate of candidates) {
      if (entries.length >= maxEntries) break
      const doc = (() => {
        try {
          return this.store.read(candidate.summary.target)
        } catch {
          return undefined
        }
      })()
      const entry = doc?.entries.find(item => item.id === candidate.entry.entryId)
      if (!entry) continue
      const content = entry.content.slice(0, MAX_CONTENT_CHARS)
      const packetEntry: MemoryPacketEntry = {
        target: candidate.summary.target,
        entryId: entry.id,
        tag: entry.tag,
        title: candidate.entry.title,
        summary: candidate.entry.summary,
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
