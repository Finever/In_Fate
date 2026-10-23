/**
 * 子 agent 上下文裁剪：只改投影副本，不动事件。
 *
 * 从最旧的工具结果开始换成短标记，保留最近的工具输出；裁完仍超限就交给
 * 调用方失败，不静默把超窗请求发给模型。
 *
 * @module if/agents/context
 */

import type { TokenEstimator } from '../compaction/estimate.ts'
import type { ToolSpec } from '../model/types.ts'
import type { HistoryMessage } from '../projections/history.ts'

export interface TrimResult {
  readonly messages: HistoryMessage[]
  readonly estimated: number
  readonly over: boolean
  readonly trimmed: number
}

function estimated(
  messages: readonly HistoryMessage[],
  system: string,
  tools: readonly ToolSpec[],
  estimator: TokenEstimator,
): number {
  return estimator.estimateMessages(messages)
    + estimator.estimate(system)
    + estimator.estimateTools(tools)
}

export function trimHistoryForContext(
  messages: readonly HistoryMessage[],
  system: string,
  tools: readonly ToolSpec[],
  maxTokens: number,
  estimator: TokenEstimator,
): TrimResult {
  let current: HistoryMessage[] = [...messages]
  let total = estimated(current, system, tools, estimator)
  let trimmed = 0

  if (total <= maxTokens) {
    return { messages: current, estimated: total, over: false, trimmed }
  }

  for (let index = 0; index < current.length; index += 1) {
    const message = current[index]!
    if (message.role !== 'tool' || message.content.length <= 200) continue
    current[index] = {
      ...message,
      content: `[tool output omitted to fit subagent context: ${message.content.length} chars]\n`
        + message.content.slice(0, 200),
    }
    trimmed += 1
    total = estimated(current, system, tools, estimator)
    if (total <= maxTokens) break
  }

  return { messages: current, estimated: total, over: total > maxTokens, trimmed }
}
