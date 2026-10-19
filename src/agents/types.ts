/**
 * 子 agent 的请求、预设与结果。
 *
 * 预设绑定模型候选链；请求只选预设，不直接指定模型。
 * 执行是异步的：受理返回 requestId，结果走事件与系统消息。
 *
 * @module if/agents/types
 */

export interface ModelChoice {
  readonly provider: string
  readonly model: string
}

export interface AgentPreset {
  readonly id: string
  /** 给模型看：什么时候选它 */
  readonly description: string
  /** 候选链，按顺序降级；免费模型不常态时靠它 */
  readonly models: readonly ModelChoice[]
  readonly systemPrompt?: string
  /** 工具白名单；默认只读 */
  readonly tools: readonly string[]
  readonly maxSteps: number
  readonly timeoutMs: number
  readonly readOnly: boolean
  readonly outputSchema?: unknown
}

export interface AgentRequest {
  readonly id: string
  readonly preset: string
  readonly prompt: string
  readonly context?: string
  readonly acceptance?: readonly string[]
  readonly priority: 'interactive' | 'normal' | 'background'
  readonly source: { readonly session: string; readonly turn?: number }
  readonly createdAt: string
  /** 受理时快照预设，之后预设被改也不影响这个请求 */
  readonly snapshot: AgentPreset
}

export interface AgentUsage {
  input: number
  output: number
  cacheRead: number
}

export interface AgentResult {
  readonly id: string
  readonly preset: string
  readonly status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly summary: string
  readonly artifacts: readonly string[]
  readonly usage: AgentUsage
  readonly steps: number
  readonly stream: string
  readonly error?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

export interface AgentPoolConfig {
  readonly maxConcurrent: number
  readonly perProvider: Readonly<Record<string, number>>
  readonly perPreset: Readonly<Record<string, number>>
  readonly queueLimit: number
}

export const DEFAULT_AGENT_POOL: AgentPoolConfig = {
  maxConcurrent: 3,
  perProvider: {},
  perPreset: {},
  queueLimit: 20,
}

export type AgentEventType =
  | 'agent.requested'
  | 'agent.started'
  | 'agent.step'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.cancelled'
  | 'agent.interrupted'
