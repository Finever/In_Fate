/**
 * 计算可压区间：闭合轮、保留最近 N 轮、不切断工具配对。
 *
 * @module if/compaction/boundary
 */

import type { Event } from '../core/events.ts'
import { groupTurns, userTurnPolicy } from '../turn/policy.ts'
import type { TokenEstimator } from './estimate.ts'
import type { CompactionConfig } from './types.ts'

export interface CompactionRange {
  readonly events: readonly Event[]
  readonly fromEventId: string
  readonly toEventId: string
  readonly turns: number
}

export interface BoundaryOptions {
  /** 从这条事件之后开始找；用于避开已被压缩覆盖的区间 */
  readonly afterEventId?: string
}

export function findCompactionRange(
  events: readonly Event[],
  config: CompactionConfig,
  estimator: TokenEstimator,
  contextWindow: number,
  options: BoundaryOptions = {},
): CompactionRange | null {
  let source = events
  if (options.afterEventId) {
    const index = events.findIndex(event => event.id === options.afterEventId)
    if (index >= 0) source = events.slice(index + 1)
  }

  const { closed } = groupTurns(source, userTurnPolicy)
  if (closed.length <= config.keepRecentTurns) return null

  const tokenBudget = contextWindow * config.keepRecentTokenRatio
  let kept = 0
  let keptTokens = 0
  let cut = closed.length

  for (let index = closed.length - 1; index >= 0; index -= 1) {
    const turn = closed[index]
    const tokens = estimator.estimate(JSON.stringify(turn))
    if (kept >= config.keepRecentTurns && keptTokens + tokens > tokenBudget) break
    kept += 1
    keptTokens += tokens
    cut = index
  }

  const compressible = closed.slice(0, cut)
  if (compressible.length === 0) return null

  const first = compressible[0]
  const last = compressible[compressible.length - 1]

  return {
    events: compressible.flat(),
    fromEventId: first[0].id,
    toEventId: last[last.length - 1].id,
    turns: compressible.length,
  }
}
