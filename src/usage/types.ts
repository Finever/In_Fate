export type UsageRecordKind = 'invocation' | 'legacy-aggregate' | 'rolled'
export type UsageModality = 'language' | 'embedding' | 'image' | 'rerank'
export type UsageSource = 'user' | 'agent' | 'subagent' | 'unknown'

export interface UsageTokenCounts {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly reasoning: number
}

export interface UsageCostRecord {
  readonly currency: string | null
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
  readonly priced: boolean
  readonly period: string
}

export interface UsageKeySnapshot {
  readonly id?: string
  readonly label?: string
  readonly masked?: string
  readonly source?: string
}

export interface UsageRequestRecord {
  readonly id: string
  readonly requestId: string
  readonly recordKind: UsageRecordKind
  /** invocation = 1；legacy-aggregate = 这一轮包含的模型调用数。 */
  readonly requestCount: number
  readonly sessionId: string
  readonly turn: number | null
  readonly agentId?: string
  readonly agentName?: string
  readonly source: UsageSource
  readonly providerId?: string
  readonly providerName?: string
  readonly modelId?: string
  readonly modelName?: string
  readonly apiKeyId?: string
  readonly apiKeyLabel?: string
  readonly apiKeyMasked?: string
  readonly apiKeySource?: string
  readonly modality: UsageModality
  readonly priority?: string
  readonly status: string
  readonly error?: string
  readonly tokens: UsageTokenCounts
  readonly cost: UsageCostRecord
  readonly pricingSnapshot?: string
  readonly durationMs?: number
  readonly firstTokenMs?: number
  readonly modelDurationMs?: number
  readonly createdAt: string
}

export interface UsageTurnRecord {
  readonly id: string
  readonly sessionId: string
  readonly turn: number | null
  readonly agentId?: string
  readonly providerId?: string
  readonly modelId?: string
  readonly status: string
  readonly steps: number
  readonly error?: string
  readonly tokens: UsageTokenCounts
  readonly cost: UsageCostRecord
  readonly durationMs?: number
  readonly modelDurationMs?: number
  readonly toolDurationMs?: number
  readonly createdAt: string
}

export interface UsageToolRecord {
  readonly sessionId: string
  readonly turn: number | null
  readonly agentId?: string
  readonly toolName: string
  readonly calls: number
  readonly ok: number
  readonly errors: number
  readonly durationMs: number
  readonly argsBytes: number
  readonly resultBytes: number
  readonly updatedAt: string
}

export interface UsageLedgerStats {
  readonly requests: number
  readonly turns: number
  readonly tools: number
  readonly legacy: number
  readonly schemaVersion: number
  readonly backfillDone: boolean
  readonly backfillAt?: string
  /** 已聚合的按天汇总行数（usage_rollup）。 */
  readonly rollupRows: number
  /** 最早的明细保留时间；没有明细时为 undefined。 */
  readonly detailSince?: string
}

/** 保留策略执行结果：聚合进的条数与删掉的明细条数。 */
export interface UsageRollupResult {
  readonly rolledRequests: number
  readonly rolledTurns: number
  readonly rolledTools: number
  readonly deletedRequests: number
  readonly deletedTurns: number
  readonly deletedTools: number
}

export interface UsageFilter {
  readonly from?: string
  readonly to?: string
  readonly providerId?: string
  readonly modelId?: string
  readonly agentId?: string
  readonly sessionId?: string
  readonly apiKeyId?: string
  readonly source?: string
  readonly modality?: string
  readonly status?: string
  readonly priority?: string
  readonly recordKind?: UsageRecordKind
  readonly priced?: boolean
  readonly currency?: string
}

export interface UsageTokenTotals extends UsageTokenCounts {
  readonly total: number
}

export interface UsageCurrencyTotal {
  readonly currency: string
  readonly total: number
}

export interface UsageOverview {
  readonly requests: number
  readonly turns: number
  readonly tokens: UsageTokenTotals
  readonly costTotal: number
  readonly costByCurrency: readonly UsageCurrencyTotal[]
  readonly unpricedRequests: number
  readonly failedRequests: number
  readonly cacheHitRate: number
  readonly activeDays: number
  readonly longestStreak: number
  readonly peakDay?: { readonly date: string; readonly tokens: number }
  readonly topModel?: {
    readonly providerId?: string
    readonly modelId?: string
    readonly tokens: number
    readonly cost: number
  }
  readonly dailyAverage: { readonly tokens: number; readonly requests: number }
  readonly avgFirstTokenMs?: number
  readonly avgDurationMs?: number
  readonly tps?: number
}

export interface UsageTimelinePoint {
  readonly bucket: string
  readonly requests: number
  readonly tokens: UsageTokenTotals
  readonly cost: number
  readonly currency?: string
}

export interface UsageGroupRow {
  readonly key: string
  readonly label: string
  readonly providerId?: string
  readonly modelId?: string
  readonly agentId?: string
  readonly sessionId?: string
  readonly apiKeyId?: string
  readonly source?: string
  readonly modality?: string
  readonly status?: string
  readonly requestCount: number
  readonly tokens: UsageTokenTotals
  readonly cost: number
  readonly currency?: string
  /** groupBy = tool 时才有：调用出错次数与总耗时。 */
  readonly toolErrors?: number
  readonly toolDurationMs?: number
}

export type UsageTimeZone = 'local' | 'utc'
export type UsageBucket = 'hour' | 'day' | 'week' | 'month'

export interface UsageRequestRow {
  readonly id: string
  readonly requestId: string
  readonly recordKind: UsageRecordKind
  readonly requestCount: number
  readonly sessionId: string
  readonly turn: number | null
  readonly agentId?: string
  readonly source: UsageSource
  readonly providerId?: string
  readonly modelId?: string
  readonly apiKeyId?: string
  readonly apiKeyLabel?: string
  readonly apiKeyMasked?: string
  readonly modality: UsageModality
  readonly priority?: string
  readonly status: string
  readonly error?: string
  readonly tokens: UsageTokenCounts & { readonly total: number }
  readonly cost: number
  readonly currency?: string
  readonly priced: boolean
  readonly durationMs?: number
  readonly firstTokenMs?: number
  readonly createdAt: string
}

export interface UsageRequestPage {
  readonly rows: readonly UsageRequestRow[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}

export type UsageGroupBy =
  | 'provider'
  | 'model'
  | 'agent'
  | 'session'
  | 'key'
  | 'source'
  | 'modality'
  | 'status'
  | 'priority'
  | 'tool'
