/**
 * 压缩的配置、摘要、锚点与事件载荷。
 *
 * 压缩只增不改：原始事件保留，摘要节点带地址，链尾有效。
 *
 * @module if/compaction/types
 */

export interface CompactionConfig {
  readonly triggerAt: number
  readonly targetAt: number
  readonly keepRecentTurns: number
  /** 保留最近多少比例的窗口 token */
  readonly keepRecentTokenRatio: number
  /** 模型卡窗口的保守系数；默认 0.9，防止声明值高于真实上限 */
  readonly contextSafetyMargin?: number
  readonly minTurnsBetween: number
  readonly pruneThresholdBytes: number
  readonly prunePreviewChars: number
  readonly summaryMaxTokens: number
  readonly compactionRetries: number
  readonly strategy: 'extractive' | 'model' | 'hybrid'
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  triggerAt: 0.85,
  targetAt: 0.4,
  keepRecentTurns: 12,
  keepRecentTokenRatio: 0.25,
  contextSafetyMargin: 0.9,
  minTurnsBetween: 5,
  pruneThresholdBytes: 8 * 1024,
  prunePreviewChars: 500,
  summaryMaxTokens: 1200,
  compactionRetries: 1,
  strategy: 'hybrid',
}

export interface CompactionAnchor {
  readonly stream: string
  readonly fromEventId: string
  readonly toEventId: string
  /** 新事件带 seq；归档后即使旧 id 不在活跃事件里，也能定位区间 */
  readonly fromSeq?: number
  readonly toSeq?: number
  readonly logAddr?: string
  /** 分支实现前先留口：当前主链为 main */
  readonly branch?: string
}

export interface CompactionSummary {
  readonly goal: string
  readonly constraints: readonly string[]
  readonly decisions: readonly { readonly what: string; readonly why: string }[]
  readonly facts: readonly string[]
  readonly failed: readonly { readonly tried: string; readonly why_failed: string }[]
  readonly open: readonly string[]
}

export interface CompactionStats {
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly foldedCount: number
  readonly prunedCount: number
  readonly durationMs?: number
  readonly model?: string
}

export interface CompactionPayload {
  readonly anchor: CompactionAnchor
  readonly supersedes?: string
  readonly rolledFrom?: string
  readonly summary: CompactionSummary
  readonly stats: CompactionStats
  /** 第几轮触发，用于冷却判断 */
  readonly turn?: number
  readonly trigger: 'auto' | 'manual'
  readonly phase: 'turn-start' | 'in-loop'
  readonly strategy: string
}

export interface PruneItem {
  readonly eventId: string
  readonly preview: string
  readonly ref?: string
  readonly beforeBytes: number
  readonly afterBytes: number
}

export interface PrunePayload {
  readonly items: readonly PruneItem[]
  /** 兼容旧事件：items 缺失时才看这些字段 */
  readonly eventIds?: readonly string[]
  readonly preview?: string
  readonly ref?: string
  readonly beforeBytes?: number
  readonly afterBytes?: number
}

export interface ExtractedFacts {
  readonly users: readonly string[]
  /** 定时任务/系统推送：压缩后不能丢 */
  readonly system: readonly string[]
  readonly assistant: readonly string[]
  readonly tools: readonly { readonly name: string; readonly args: string; readonly result: string }[]
  readonly errors: readonly { readonly what: string; readonly error: string }[]
  readonly tasks: readonly { readonly id: string; readonly state: string; readonly title: string }[]
}

/** 摘要生成器：给模型或兜底实现用 */
export type Summarizer = (input: {
  readonly previous?: CompactionSummary
  readonly facts: ExtractedFacts
}) => Promise<CompactionSummary>
