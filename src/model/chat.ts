/**
 * 模型请求的公共形状：适配器只管把这份请求翻成厂商格式。
 *
 * @module if/model/chat
 */

import { randomUUID } from 'node:crypto'
import type { HistoryMessage } from '../projections/history.ts'
import type { ResolvedModel } from './registry.ts'
import type { ToolSpec } from './types.ts'
import type { ModelGate, ModelPriority } from './gate.ts'
import type { ModelRetryInfo, ModelRetryPolicy } from './retry.ts'

export interface ChatRequest {
  readonly resolved: ResolvedModel
  readonly system: string
  readonly messages: readonly HistoryMessage[]
  readonly tools?: readonly ToolSpec[]
  readonly temperature?: number
  readonly maxTokens?: number
  /** 最后一条 assistant 的续写前缀；只有 supportsAssistantPrefill 的端点会用。 */
  readonly assistantPrefill?: string
  readonly signal?: AbortSignal
  /** system 角色的消息是否转成 user（部分来源不认 system）。默认 false。 */
  readonly systemAsUser?: boolean
  /** provider 级准入；不传就不排队 */
  readonly gate?: ModelGate
  readonly priority?: ModelPriority
  /** 重试、超时、退避；不传用默认策略 */
  readonly retry?: ModelRetryPolicy
  /** 每次尝试前回调，给指标用 */
  readonly onAttempt?: (attempt: number) => void
  /** 即将重试前回调 */
  readonly onRetry?: (info: ModelRetryInfo) => void
}

/** 厂商没给工具调用 id 时自己造一个，跨轮也不能撞。 */
export function fallbackCallId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/** 历史消息里的纯文本。 */
export function textOf(message: HistoryMessage): string {
  if (message.role === 'tool') return message.content
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** 主 system 与历史里的 system 注入合并；有些格式只认一个 system 字段。 */
export function systemText(request: ChatRequest): string {
  const parts = [
    request.system,
    ...request.messages
      .filter(message => message.role === 'system')
      .map(message => textOf(message)),
  ].filter(text => text.length > 0)
  return parts.join('\n\n')
}
