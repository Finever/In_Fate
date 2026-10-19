/**
 * 执行一次压缩：先 prune，再 fold；锚点向后扩展，链尾有效。
 *
 * @module if/compaction/fold
 */

import type { EventStore } from '../core/store.ts'
import type { ToolSpec } from '../model/types.ts'
import type { HistoryMessage } from '../projections/history.ts'
import type { SpillPolicy } from '../tools/spill.ts'
import { findCompactionRange } from './boundary.ts'
import { pressureOf, type TokenEstimator } from './estimate.ts'
import { extractFacts } from './extract.ts'
import { effectiveCompactions } from './project.ts'
import { buildPrunePayload, findPrunable } from './prune.ts'
import { mergeSummaries } from './summarize.ts'
import type { CompactionConfig, CompactionPayload, Summarizer } from './types.ts'

export interface CompactOptions {
  readonly store: EventStore
  readonly stream: string
  readonly config: CompactionConfig
  readonly estimator: TokenEstimator
  readonly contextWindow: number
  readonly maxOutputTokens?: number
  readonly system: string
  readonly tools: readonly ToolSpec[]
  readonly messages: readonly HistoryMessage[]
  readonly summarizer?: Summarizer
  readonly spill?: SpillPolicy
}

export async function compactIfNeeded(options: CompactOptions): Promise<CompactionPayload | null> {
  const pressure = pressureOf({
    messages: options.messages,
    system: options.system,
    tools: options.tools,
    contextWindow: options.contextWindow,
    maxOutputTokens: options.maxOutputTokens,
  }, options.estimator)

  if (pressure.pressure < options.config.triggerAt) return null

  const started = Date.now()
  let prunedCount = 0

  // 第一级：裁工具结果，无模型、可重复执行。
  if (options.spill) {
    const candidates = findPrunable(options.store.read(), options.config.pruneThresholdBytes)
    if (candidates.length > 0) {
      options.store.append({
        stream: options.stream,
        actor: 'system',
        type: 'compaction.pruned',
        payload: buildPrunePayload(candidates, options.spill),
      })
      prunedCount = candidates.length
    }
  }

  const events = options.store.read()
  const range = findCompactionRange(events, options.config, options.estimator, options.contextWindow)
  if (!range) return null

  // 与旧链合并：锚点只能向后扩展。
  const previous = effectiveCompactions(events).at(-1)
  const fromEventId = previous && previous.payload.anchor.fromEventId < range.fromEventId
    ? previous.payload.anchor.fromEventId
    : range.fromEventId
  const toEventId = previous && previous.payload.anchor.toEventId > range.toEventId
    ? previous.payload.anchor.toEventId
    : range.toEventId

  if (previous) {
    const extendsBack = fromEventId <= previous.payload.anchor.fromEventId
    const extendsForward = toEventId > previous.payload.anchor.toEventId
    if (!extendsBack || !extendsForward) {
      throw new Error('compaction anchor does not extend the previous range')
    }
  }

  const facts = extractFacts(range.events)
  const summary = options.summarizer
    ? await options.summarizer({ previous: previous?.payload.summary, facts })
    : mergeSummaries(previous?.payload.summary, facts)

  const retained = Math.max(
    0,
    pressure.estimated - options.estimator.estimate(JSON.stringify(range.events)),
  )
  const tokensAfter = Math.max(
    1,
    options.estimator.estimate(JSON.stringify(summary)) + retained,
  )

  const payload: CompactionPayload = {
    anchor: { stream: options.stream, fromEventId, toEventId },
    ...(previous ? { supersedes: previous.eventId, rolledFrom: previous.eventId } : {}),
    summary,
    stats: {
      tokensBefore: pressure.estimated,
      tokensAfter,
      foldedCount: range.events.length,
      prunedCount,
      durationMs: Date.now() - started,
    },
    trigger: 'auto',
    phase: 'turn-start',
    strategy: options.config.strategy,
  }

  options.store.append({
    stream: options.stream,
    actor: 'system',
    type: 'context.compacted',
    payload,
  })

  return payload
}
