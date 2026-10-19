/**
 * 执行压缩：先 prune，再 fold；锚点向后扩展，链尾有效。
 *
 * 失败/压缩之间有冷却；压一次没到目标就继续压，最多三段。
 *
 * @module if/compaction/fold
 */

import type { Event } from '../core/events.ts'
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
import type {
  CompactionConfig,
  CompactionPayload,
  ExtractedFacts,
  Summarizer,
} from './types.ts'

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
  /** 当前对话轮次，用于冷却判断 */
  readonly currentTurn?: number
  /** 压缩后重新投影；不传就只压一段 */
  readonly projectMessages?: () => readonly HistoryMessage[]
}

function lastCompactionTurn(events: readonly Event[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'context.compacted' && event.type !== 'compaction.failed') continue
    const turn = event.payload.turn
    if (typeof turn === 'number') return turn
  }
  return undefined
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/** 摘要输入限长：条数和单条长度双重截断。 */
function limitFacts(facts: ExtractedFacts, maxChars: number): ExtractedFacts {
  const limited: ExtractedFacts = {
    users: facts.users.slice(-10).map(item => clip(item, 400)),
    system: facts.system.slice(-6).map(item => clip(item, 300)),
    assistant: facts.assistant.slice(-10).map(item => clip(item, 300)),
    tools: facts.tools.slice(-12).map(item => ({
      name: item.name,
      args: clip(item.args, 160),
      result: clip(item.result, 240),
    })),
    errors: facts.errors.slice(-5).map(item => ({
      what: clip(item.what, 80),
      error: clip(item.error, 240),
    })),
    tasks: facts.tasks.slice(-10),
  }

  if (JSON.stringify(limited).length <= maxChars) return limited

  return {
    users: limited.users.slice(-5),
    system: limited.system.slice(-3),
    assistant: limited.assistant.slice(-5),
    tools: limited.tools.slice(-6),
    errors: limited.errors.slice(-3),
    tasks: limited.tasks.slice(-5),
  }
}

export async function compactIfNeeded(options: CompactOptions): Promise<CompactionPayload | null> {
  const currentTurn = options.currentTurn ?? 0
  const initialEvents = options.store.read()

  // 冷却：最近一次压缩/失败之后，未满 minTurnsBetween 不再压。
  const lastTurn = lastCompactionTurn(initialEvents)
  if (
    lastTurn !== undefined
    && currentTurn > 0
    && currentTurn - lastTurn < options.config.minTurnsBetween
  ) {
    return null
  }

  const started = Date.now()
  let prunedCount = 0
  let lastPayload: CompactionPayload | null = null

  // 最多压三段；每段压完重新估算，没到 target 就继续。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const events = options.store.read()
    const messages = attempt === 0
      ? options.messages
      : (options.projectMessages?.() ?? options.messages)

    const pressure = pressureOf({
      messages,
      system: options.system,
      tools: options.tools,
      contextWindow: options.contextWindow,
      maxOutputTokens: options.maxOutputTokens,
    }, options.estimator)

    if (pressure.pressure < options.config.triggerAt) return lastPayload

    // 第一级裁剪只做一次。
    if (attempt === 0 && options.spill) {
      const candidates = findPrunable(events, options.config.pruneThresholdBytes)
      if (candidates.length > 0) {
        options.store.append({
          stream: options.stream,
          actor: 'system',
          type: 'compaction.pruned',
          payload: buildPrunePayload(candidates, options.spill) as unknown as Record<string, unknown>,
        })
        prunedCount = candidates.length
      }
    }

    const current = options.store.read()
    const previous = effectiveCompactions(current).at(-1)
    const range = findCompactionRange(
      current,
      options.config,
      options.estimator,
      options.contextWindow,
      previous ? { afterEventId: previous.payload.anchor.toEventId } : {},
    )
    if (!range) break

    // 新锚点覆盖旧链：from 取旧链起点，to 取新边界。
    const fromEventId = previous
      ? previous.payload.anchor.fromEventId
      : range.fromEventId
    const toEventId = range.toEventId

    if (previous) {
      const positions = new Map<string, number>()
      current.forEach((event, index) => positions.set(event.id, index))
      const previousTo = positions.get(previous.payload.anchor.toEventId) ?? -1
      const nextTo = positions.get(toEventId) ?? -1
      if (nextTo <= previousTo) {
        throw new Error('compaction anchor does not extend the previous range')
      }
    }

    const facts = limitFacts(
      extractFacts(range.events),
      Math.max(2000, options.config.summaryMaxTokens * 4),
    )
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
      turn: currentTurn,
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
      payload: payload as unknown as Record<string, unknown>,
    })

    lastPayload = payload

    // 达到目标就停；否则再压一段。
    if (tokensAfter / pressure.usable <= options.config.targetAt) break
  }

  return lastPayload
}
