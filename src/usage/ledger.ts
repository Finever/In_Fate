/**
 * 用量账本（SQLite）。
 *
 * 事件流仍是真相；账本只是可重建的投影，用来做全局统计和图表。
 * 首次打开会从历史 turn.completed 回填 legacy 聚合；新会话由 run loop
 * 每步模型调用落 usage.recorded，再由账本消费。
 *
 * @module if/usage/ledger
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Event } from '../core/events.ts'
import type {
  UsageBucket,
  UsageCostRecord,
  UsageFilter,
  UsageGroupBy,
  UsageGroupRow,
  UsageLedgerStats,
  UsageOverview,
  UsageRequestPage,
  UsageRequestRecord,
  UsageRequestRow,
  UsageRollupResult,
  UsageSource,
  UsageTimeZone,
  UsageTimelinePoint,
  UsageTokenCounts,
  UsageTokenTotals,
  UsageToolRecord,
  UsageTurnRecord,
} from './types.ts'

const SCHEMA_VERSION = 4

function emptyTokens(): UsageTokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

function emptyCost(): UsageCostRecord {
  return {
    currency: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    priced: false,
    period: 'standard',
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function sessionIdOf(stream: string): string {
  return stream.startsWith('session:') ? stream.slice('session:'.length) : stream
}

function tokensFrom(value: unknown): UsageTokenCounts {
  const usage = asRecord(value)
  return {
    input: asNumber(usage.input),
    output: asNumber(usage.output),
    cacheRead: asNumber(usage.cacheRead),
    cacheWrite: asNumber(usage.cacheWrite),
    reasoning: asNumber(usage.reasoning),
  }
}

function costFrom(value: unknown): UsageCostRecord {
  const cost = asRecord(value)
  return {
    currency: typeof cost.currency === 'string' ? cost.currency : null,
    input: asNumber(cost.input),
    output: asNumber(cost.output),
    cacheRead: asNumber(cost.cacheRead),
    cacheWrite: asNumber(cost.cacheWrite),
    total: asNumber(cost.total),
    priced: cost.priced === true,
    period: typeof cost.period === 'string' ? cost.period : 'standard',
  }
}

function modelOf(value: unknown): { providerId?: string; modelId?: string } {
  const model = asRecord(value)
  return {
    ...(asString(model.provider) ? { providerId: String(model.provider) } : {}),
    ...(asString(model.model) ? { modelId: String(model.model) } : {}),
  }
}

function sourceOf(value: unknown): UsageSource {
  return value === 'user' || value === 'agent' || value === 'subagent' ? value : 'unknown'
}

/** 查询层共用：条件片段 + 位置参数。 */
interface WhereParts {
  sql: string
  params: (string | number)[]
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function nextDay(date: string): string {
  const at = new Date(`${date}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + 1)
  return at.toISOString().slice(0, 10)
}

function eqFilter(parts: WhereParts, column: string, value: string | undefined): void {
  if (value === undefined || value === '') return
  parts.sql += ` AND ${column} = ?`
  parts.params.push(value)
}

function timeRange(parts: WhereParts, filter: UsageFilter): void {
  if (filter.from) {
    parts.sql += ' AND created_at >= ?'
    parts.params.push(filter.from)
  }
  if (filter.to) {
    if (DATE_ONLY.test(filter.to)) {
      // 纯日期按自然日包含：< 次日零点。
      parts.sql += ' AND created_at < ?'
      parts.params.push(nextDay(filter.to))
    } else {
      parts.sql += ' AND created_at <= ?'
      parts.params.push(filter.to)
    }
  }
}

function requestWhere(filter: UsageFilter = {}): WhereParts {
  const parts: WhereParts = { sql: 'WHERE 1=1', params: [] }
  timeRange(parts, filter)
  eqFilter(parts, 'provider_id', filter.providerId)
  eqFilter(parts, 'model_id', filter.modelId)
  eqFilter(parts, 'agent_id', filter.agentId)
  eqFilter(parts, 'session_id', filter.sessionId)
  eqFilter(parts, 'api_key_id', filter.apiKeyId)
  eqFilter(parts, 'source', filter.source)
  eqFilter(parts, 'modality', filter.modality)
  eqFilter(parts, 'status', filter.status)
  eqFilter(parts, 'priority', filter.priority)
  eqFilter(parts, 'record_kind', filter.recordKind)
  if (filter.priced !== undefined) {
    parts.sql += ' AND cost_priced = ?'
    parts.params.push(filter.priced ? 1 : 0)
  }
  if (filter.currency !== undefined) {
    if (filter.currency === '') parts.sql += ' AND cost_currency IS NULL'
    else eqFilter(parts, 'cost_currency', filter.currency)
  }
  return parts
}

function turnWhere(filter: UsageFilter = {}): WhereParts {
  const parts: WhereParts = { sql: 'WHERE 1=1', params: [] }
  timeRange(parts, filter)
  eqFilter(parts, 'agent_id', filter.agentId)
  eqFilter(parts, 'session_id', filter.sessionId)
  eqFilter(parts, 'provider_id', filter.providerId)
  eqFilter(parts, 'model_id', filter.modelId)
  eqFilter(parts, 'status', filter.status)
  return parts
}

function toolWhere(filter: UsageFilter = {}): WhereParts {
  const parts: WhereParts = { sql: 'WHERE 1=1', params: [] }
  eqFilter(parts, 'agent_id', filter.agentId)
  eqFilter(parts, 'session_id', filter.sessionId)
  return parts
}

const TOKEN_SUMS = `
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
`

/**
 * total 口径 = 输入 + 输出（对齐 Cherry 的「提示 + 补全」）；
 * 缓存读写单列，不并进输入（各家 API 对 input 是否含缓存的语义不一致）。
 */
function totalsFrom(row: Record<string, unknown>): UsageTokenTotals {
  const input = asNumber(row.input_tokens)
  const output = asNumber(row.output_tokens)
  return {
    input,
    output,
    cacheRead: asNumber(row.cache_read_tokens),
    cacheWrite: asNumber(row.cache_write_tokens),
    reasoning: asNumber(row.reasoning_tokens),
    total: input + output,
  }
}

function emptyTotals(): UsageTokenTotals {
  return { ...emptyTokens(), total: 0 }
}

function streakOf(days: readonly string[]): number {
  let longest = 0
  let current = 0
  let prev = ''
  for (const day of days) {
    current = prev !== '' && nextDay(prev) === day ? current + 1 : 1
    if (current > longest) longest = current
    prev = day
  }
  return longest
}

function bucketExpr(bucket: UsageBucket, utc: boolean): string {
  const tz = utc ? '' : ", 'localtime'"
  switch (bucket) {
    case 'hour':
      return `strftime('%Y-%m-%d %H:00', created_at${tz})`
    case 'week':
      // 周一为一周之始。
      return `date(created_at${tz}, 'weekday 0', '-6 days')`
    case 'month':
      return `strftime('%Y-%m', created_at${tz})`
    case 'day':
    default:
      return `date(created_at${tz})`
  }
}

const GROUP_COLUMNS: Record<Exclude<UsageGroupBy, 'tool'>, {
  cols: readonly string[]
  label: string
}> = {
  provider: { cols: ['provider_id'], label: "COALESCE(provider_name, provider_id, '未知')" },
  model: { cols: ['provider_id', 'model_id'], label: "COALESCE(model_name, model_id, '未知')" },
  agent: { cols: ['agent_id'], label: "COALESCE(agent_name, agent_id, '未知')" },
  session: {
    cols: ['session_id'],
    label: "CASE WHEN session_id IS NULL OR session_id = '' THEN '（已聚合）' ELSE session_id END",
  },
  key: {
    cols: ['api_key_id', 'api_key_masked'],
    label: "COALESCE(api_key_label, api_key_masked, api_key_id, '未知')",
  },
  source: { cols: ['source'], label: 'source' },
  modality: { cols: ['modality'], label: 'modality' },
  status: { cols: ['status'], label: 'status' },
  priority: { cols: ['priority'], label: 'priority' },
}

function groupRowFrom(
  groupBy: Exclude<UsageGroupBy, 'tool'>,
  row: Record<string, unknown>,
): UsageGroupRow {
  const label = String(row.label ?? '')
  const base: UsageGroupRow = {
    key: '',
    label,
    requestCount: asNumber(row.requests),
    tokens: totalsFrom(row),
    cost: asNumber(row.cost),
    ...(asString(row.currency) ? { currency: String(row.currency) } : {}),
  }
  switch (groupBy) {
    case 'provider': {
      const id = asString(row.c0)
      return { ...base, key: id ?? label, ...(id ? { providerId: id } : {}) }
    }
    case 'model': {
      const providerId = asString(row.c0)
      const modelId = asString(row.c1)
      return {
        ...base,
        key: `${providerId ?? ''}|${modelId ?? ''}`,
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
      }
    }
    case 'agent': {
      const id = asString(row.c0)
      return { ...base, key: id ?? label, ...(id ? { agentId: id } : {}) }
    }
    case 'session': {
      const id = asString(row.c0)
      return { ...base, key: id ?? label, ...(id ? { sessionId: id } : {}) }
    }
    case 'key': {
      const id = asString(row.c0)
      return { ...base, key: id ?? asString(row.c1) ?? label, ...(id ? { apiKeyId: id } : {}) }
    }
    case 'source': {
      const value = asString(row.c0) ?? label
      return { ...base, key: value, source: value }
    }
    case 'modality': {
      const value = asString(row.c0) ?? label
      return { ...base, key: value, modality: value }
    }
    case 'status': {
      const value = asString(row.c0) ?? label
      return { ...base, key: value, status: value }
    }
    case 'priority':
    default: {
      return { ...base, key: asString(row.c0) ?? label }
    }
  }
}

function requestRowFrom(row: Record<string, unknown>): UsageRequestRow {
  const input = asNumber(row.input_tokens)
  const output = asNumber(row.output_tokens)
  const modality = row.modality
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    recordKind: row.record_kind === 'legacy-aggregate'
      ? 'legacy-aggregate'
      : row.record_kind === 'rolled' ? 'rolled' : 'invocation',
    requestCount: asNumber(row.request_count, 1),
    sessionId: String(row.session_id),
    turn: typeof row.turn === 'number' ? row.turn : null,
    ...(asString(row.agent_id) ? { agentId: String(row.agent_id) } : {}),
    source: sourceOf(row.source),
    ...(asString(row.provider_id) ? { providerId: String(row.provider_id) } : {}),
    ...(asString(row.model_id) ? { modelId: String(row.model_id) } : {}),
    ...(asString(row.api_key_id) ? { apiKeyId: String(row.api_key_id) } : {}),
    ...(asString(row.api_key_label) ? { apiKeyLabel: String(row.api_key_label) } : {}),
    ...(asString(row.api_key_masked) ? { apiKeyMasked: String(row.api_key_masked) } : {}),
    modality: modality === 'embedding' || modality === 'image' || modality === 'rerank'
      ? modality
      : 'language',
    ...(asString(row.priority) ? { priority: String(row.priority) } : {}),
    status: asString(row.status) ?? 'completed',
    ...(asString(row.error) ? { error: String(row.error) } : {}),
    tokens: {
      input,
      output,
      cacheRead: asNumber(row.cache_read_tokens),
      cacheWrite: asNumber(row.cache_write_tokens),
      reasoning: asNumber(row.reasoning_tokens),
      total: input + output,
    },
    cost: asNumber(row.cost_total),
    ...(asString(row.cost_currency) ? { currency: String(row.cost_currency) } : {}),
    priced: row.cost_priced === 1,
    ...(typeof row.duration_ms === 'number' ? { durationMs: row.duration_ms } : {}),
    ...(typeof row.first_token_ms === 'number' ? { firstTokenMs: row.first_token_ms } : {}),
    createdAt: String(row.created_at),
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(raw, min), max)
}

export class UsageLedger {
  readonly file: string
  private readonly db: DatabaseSync
  private closed = false

  private constructor(file: string) {
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  static open(file: string): UsageLedger {
    return new UsageLedger(file)
  }

  static openForDataRoot(dataRoot: string): UsageLedger {
    return new UsageLedger(join(dataRoot, 'usage', 'usage.sqlite'))
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_request (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        record_kind TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        turn INTEGER,
        agent_id TEXT,
        agent_name TEXT,
        source TEXT NOT NULL,
        provider_id TEXT,
        provider_name TEXT,
        model_id TEXT,
        model_name TEXT,
        api_key_id TEXT,
        api_key_label TEXT,
        api_key_masked TEXT,
        api_key_source TEXT,
        modality TEXT NOT NULL,
        priority TEXT,
        status TEXT NOT NULL,
        error TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost_input REAL NOT NULL,
        cost_output REAL NOT NULL,
        cost_cache_read REAL NOT NULL,
        cost_cache_write REAL NOT NULL,
        cost_total REAL NOT NULL,
        cost_currency TEXT,
        cost_priced INTEGER NOT NULL,
        price_period TEXT,
        pricing_snapshot TEXT,
        duration_ms INTEGER,
        first_token_ms INTEGER,
        model_duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_turn (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER,
        agent_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL,
        steps INTEGER NOT NULL,
        error TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost_input REAL NOT NULL,
        cost_output REAL NOT NULL,
        cost_cache_read REAL NOT NULL,
        cost_cache_write REAL NOT NULL,
        cost_total REAL NOT NULL,
        cost_currency TEXT,
        cost_priced INTEGER NOT NULL,
        price_period TEXT,
        duration_ms INTEGER,
        model_duration_ms INTEGER,
        tool_duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_tool (
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        agent_id TEXT,
        tool_name TEXT NOT NULL,
        calls INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        args_bytes INTEGER NOT NULL,
        result_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn, tool_name)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_request_created
        ON usage_request(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_request_session
        ON usage_request(session_id, turn);
      CREATE INDEX IF NOT EXISTS idx_usage_request_agent
        ON usage_request(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_request_model
        ON usage_request(model_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_request_provider
        ON usage_request(provider_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_turn_created
        ON usage_turn(created_at);
      CREATE TABLE IF NOT EXISTS usage_rollup (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        agent_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        modality TEXT NOT NULL,
        currency TEXT,
        requests INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost_total REAL NOT NULL,
        duration_sum REAL NOT NULL,
        duration_n INTEGER NOT NULL,
        first_token_sum REAL NOT NULL,
        first_token_n INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_rollup_day ON usage_rollup(day);
      CREATE TABLE IF NOT EXISTS usage_rollup_turn (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        agent_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL,
        currency TEXT,
        turns INTEGER NOT NULL,
        steps INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost_total REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_rollup_turn_day ON usage_rollup_turn(day);
      CREATE TABLE IF NOT EXISTS usage_rollup_tool (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        agent_id TEXT,
        tool_name TEXT NOT NULL,
        calls INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_rollup_tool_day ON usage_rollup_tool(day);
    `)
    // 视图要跟随定义更新，先删再建。
    this.db.exec('DROP VIEW IF EXISTS usage_all')
    this.db.exec('DROP VIEW IF EXISTS usage_turn_all')
    this.db.exec('DROP VIEW IF EXISTS usage_tool_all')
    this.db.exec(`
      CREATE VIEW usage_all AS
        SELECT id, request_id, record_kind, request_count, session_id, turn,
          agent_id, agent_name, source, provider_id, provider_name,
          model_id, model_name, api_key_id, api_key_label, api_key_masked, api_key_source,
          modality, priority, status, error,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
          cost_currency, cost_priced, price_period, pricing_snapshot,
          duration_ms, first_token_ms, model_duration_ms, created_at
        FROM usage_request
        UNION ALL
        SELECT id, id, 'rolled', requests, '', NULL,
          agent_id, NULL, source, provider_id, NULL,
          model_id, NULL, NULL, NULL, NULL, NULL,
          modality, NULL, status, NULL,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          0, 0, 0, 0, cost_total,
          currency,
          CASE WHEN currency IS NULL THEN 0 ELSE 1 END,
          NULL, NULL,
          CASE WHEN duration_n > 0 THEN CAST(duration_sum / duration_n AS INTEGER) END,
          CASE WHEN first_token_n > 0 THEN CAST(first_token_sum / first_token_n AS INTEGER) END,
          NULL,
          day || 'T00:00:00.000Z'
        FROM usage_rollup;
      CREATE VIEW usage_turn_all AS
        SELECT session_id, turn, agent_id, provider_id, model_id, status, steps, error,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          cost_total, cost_currency, cost_priced,
          duration_ms, model_duration_ms, tool_duration_ms, created_at, 1 AS row_count
        FROM usage_turn
        UNION ALL
        SELECT '', NULL, agent_id, provider_id, model_id, status, steps, NULL,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          cost_total, currency, CASE WHEN currency IS NULL THEN 0 ELSE 1 END,
          NULL, NULL, NULL, day || 'T00:00:00.000Z', turns
        FROM usage_rollup_turn;
      CREATE VIEW usage_tool_all AS
        SELECT substr(updated_at, 1, 10) AS day, session_id, agent_id, tool_name,
          calls, ok, errors, duration_ms, args_bytes, result_bytes, updated_at
        FROM usage_tool
        UNION ALL
        SELECT day, '' AS session_id, agent_id, tool_name,
          calls, calls AS ok, errors, duration_ms, 0, 0, updated_at
        FROM usage_rollup_tool;
    `)
    const current = Number(this.meta('schema_version') ?? '0')
    if (current !== SCHEMA_VERSION) {
      // 账本是投影：schema 变化直接重建，原始事件不受影响。
      for (const table of [
        'usage_request', 'usage_turn', 'usage_tool',
        'usage_rollup', 'usage_rollup_turn', 'usage_rollup_tool',
      ]) {
        this.db.exec(`DELETE FROM ${table}`)
      }
      this.setMeta('schema_version', String(SCHEMA_VERSION))
      this.setMeta('backfill_done', '0')
    }
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM usage_meta WHERE k = ?').get(key) as
      | { v: string }
      | undefined
    return row?.v
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO usage_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    ).run(key, value)
  }

  recordRequest(record: UsageRequestRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO usage_request (
        id, request_id, record_kind, request_count, session_id, turn,
        agent_id, agent_name, source, provider_id, provider_name,
        model_id, model_name, api_key_id, api_key_label, api_key_masked, api_key_source,
        modality, priority, status, error,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        cost_currency, cost_priced, price_period, pricing_snapshot,
        duration_ms, first_token_ms, model_duration_ms, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      record.id,
      record.requestId,
      record.recordKind,
      record.requestCount,
      record.sessionId,
      record.turn,
      record.agentId ?? null,
      record.agentName ?? null,
      record.source,
      record.providerId ?? null,
      record.providerName ?? null,
      record.modelId ?? null,
      record.modelName ?? null,
      record.apiKeyId ?? null,
      record.apiKeyLabel ?? null,
      record.apiKeyMasked ?? null,
      record.apiKeySource ?? null,
      record.modality,
      record.priority ?? null,
      record.status,
      record.error ?? null,
      record.tokens.input,
      record.tokens.output,
      record.tokens.cacheRead,
      record.tokens.cacheWrite,
      record.tokens.reasoning,
      record.cost.input,
      record.cost.output,
      record.cost.cacheRead,
      record.cost.cacheWrite,
      record.cost.total,
      record.cost.currency,
      record.cost.priced ? 1 : 0,
      record.cost.period,
      record.pricingSnapshot ?? null,
      record.durationMs ?? null,
      record.firstTokenMs ?? null,
      record.modelDurationMs ?? null,
      record.createdAt,
    )
  }

  recordTurn(record: UsageTurnRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO usage_turn (
        id, session_id, turn, agent_id, provider_id, model_id, status, steps, error,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        cost_currency, cost_priced, price_period,
        duration_ms, model_duration_ms, tool_duration_ms, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      record.id,
      record.sessionId,
      record.turn,
      record.agentId ?? null,
      record.providerId ?? null,
      record.modelId ?? null,
      record.status,
      record.steps,
      record.error ?? null,
      record.tokens.input,
      record.tokens.output,
      record.tokens.cacheRead,
      record.tokens.cacheWrite,
      record.tokens.reasoning,
      record.cost.input,
      record.cost.output,
      record.cost.cacheRead,
      record.cost.cacheWrite,
      record.cost.total,
      record.cost.currency,
      record.cost.priced ? 1 : 0,
      record.cost.period,
      record.durationMs ?? null,
      record.modelDurationMs ?? null,
      record.toolDurationMs ?? null,
      record.createdAt,
    )
  }

  recordTool(record: UsageToolRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO usage_tool (
        session_id, turn, agent_id, tool_name, calls, ok, errors,
        duration_ms, args_bytes, result_bytes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.sessionId,
      record.turn ?? -1,
      record.agentId ?? null,
      record.toolName,
      record.calls,
      record.ok,
      record.errors,
      record.durationMs,
      record.argsBytes,
      record.resultBytes,
      record.updatedAt,
    )
  }

  hasRequestsForTurn(sessionId: string, turn: number | null): boolean {
    if (turn === null) return false
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM usage_request WHERE session_id = ? AND turn = ?',
    ).get(sessionId, turn) as { n: number } | undefined
    return (row?.n ?? 0) > 0
  }

  /** 消费一条事件；返回是否写入。幂等，可重复回放。 */
  recordEvent(event: Event): boolean {
    if (event.type === 'usage.recorded') {
      const record = this.requestFromUsageEvent(event)
      if (!record) return false
      this.recordRequest(record)
      return true
    }
    if (event.type === 'turn.completed') {
      const turn = this.turnFromCompleted(event)
      if (!turn) return false
      this.recordTurn(turn)
      if (!this.hasRequestsForTurn(turn.sessionId, turn.turn)) {
        this.recordRequest(this.legacyFromCompleted(event, turn))
      }
      return true
    }
    return false
  }

  private requestFromUsageEvent(event: Event): UsageRequestRecord | undefined {
    const payload = event.payload
    const sessionId = sessionIdOf(event.stream)
    const requestId = asString(payload.requestId)
    if (!requestId) return undefined
    const model = modelOf(
      typeof payload.model === 'object' && payload.model !== null
        ? payload.model
        : { provider: payload.provider, model: payload.model },
    )
    const key = asRecord(payload.key)
    return {
      id: event.id,
      requestId,
      recordKind: 'invocation',
      requestCount: 1,
      sessionId,
      turn: typeof payload.turn === 'number' ? payload.turn : null,
      ...(asString(payload.agentId) ? { agentId: String(payload.agentId) } : {}),
      source: sourceOf(payload.source),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      ...(asString(payload.providerName) ? { providerName: String(payload.providerName) } : {}),
      ...(model.modelId ? { modelId: model.modelId } : {}),
      ...(asString(payload.modelName) ? { modelName: String(payload.modelName) } : {}),
      ...(asString(key.id) ? { apiKeyId: String(key.id) } : {}),
      ...(asString(key.label) ? { apiKeyLabel: String(key.label) } : {}),
      ...(asString(key.masked) ? { apiKeyMasked: String(key.masked) } : {}),
      ...(asString(key.source) ? { apiKeySource: String(key.source) } : {}),
      modality: 'language',
      ...(asString(payload.priority) ? { priority: String(payload.priority) } : {}),
      status: asString(payload.status) ?? 'completed',
      ...(asString(payload.error) ? { error: String(payload.error) } : {}),
      tokens: tokensFrom(payload.usage),
      cost: costFrom(payload.cost),
      ...(asString(payload.pricingSnapshot) ? { pricingSnapshot: String(payload.pricingSnapshot) } : {}),
      ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
      ...(typeof payload.firstTokenMs === 'number' ? { firstTokenMs: payload.firstTokenMs } : {}),
      ...(typeof payload.modelDurationMs === 'number' ? { modelDurationMs: payload.modelDurationMs } : {}),
      createdAt: asString(payload.requestedAt) ?? event.ts,
    }
  }

  private turnFromCompleted(event: Event): UsageTurnRecord | undefined {
    const payload = event.payload
    const sessionId = sessionIdOf(event.stream)
    const model = modelOf(payload.model)
    return {
      id: event.id,
      sessionId,
      turn: typeof payload.turn === 'number' ? payload.turn : null,
      ...(asString(payload.agentId) ? { agentId: String(payload.agentId) } : {}),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      ...(model.modelId ? { modelId: model.modelId } : {}),
      status: asString(payload.status) ?? 'completed',
      steps: asNumber(payload.steps),
      ...(asString(payload.error) ? { error: String(payload.error) } : {}),
      tokens: tokensFrom(payload.usage),
      cost: costFrom(payload.cost),
      ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
      ...(typeof payload.modelDurationMs === 'number' ? { modelDurationMs: payload.modelDurationMs } : {}),
      ...(typeof payload.toolDurationMs === 'number' ? { toolDurationMs: payload.toolDurationMs } : {}),
      createdAt: event.ts,
    }
  }

  private legacyFromCompleted(event: Event, turn: UsageTurnRecord): UsageRequestRecord {
    const payload = event.payload
    return {
      id: `legacy:${event.id}`,
      requestId: event.id,
      recordKind: 'legacy-aggregate',
      requestCount: Math.max(1, turn.steps),
      sessionId: turn.sessionId,
      turn: turn.turn,
      ...(turn.agentId ? { agentId: turn.agentId } : {}),
      source: sourceOf(payload.source),
      ...(turn.providerId ? { providerId: turn.providerId } : {}),
      ...(turn.modelId ? { modelId: turn.modelId } : {}),
      modality: 'language',
      status: turn.status,
      ...(turn.error ? { error: turn.error } : {}),
      tokens: turn.tokens,
      cost: turn.cost,
      ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
      createdAt: turn.createdAt,
    }
  }

  stats(): UsageLedgerStats {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
        | { n: number }
        | undefined
      return row?.n ?? 0
    }
    const legacy = this.db.prepare(
      "SELECT COUNT(*) AS n FROM usage_request WHERE record_kind = 'legacy-aggregate'",
    ).get() as { n: number } | undefined
    const earliest = this.db.prepare(
      'SELECT MIN(created_at) AS v FROM usage_request',
    ).get() as { v: string | null } | undefined
    return {
      requests: count('usage_request'),
      turns: count('usage_turn'),
      tools: count('usage_tool'),
      legacy: legacy?.n ?? 0,
      schemaVersion: Number(this.meta('schema_version') ?? String(SCHEMA_VERSION)),
      backfillDone: this.meta('backfill_done') === '1',
      ...(this.meta('backfill_at') ? { backfillAt: this.meta('backfill_at')! } : {}),
      rollupRows: count('usage_rollup'),
      ...(earliest?.v ? { detailSince: earliest.v } : {}),
    }
  }

  /**
   * 保留策略：早于 detailDays 的明细先聚合成按天汇总（usage_rollup*），
   * 再删除明细。聚合与删除在同一事务里，重复执行幂等；0 或负数 = 永久保留。
   * 天边界按 UTC 日切。
   */
  rollup(options: { detailDays: number; now?: Date }): UsageRollupResult {
    const counts = {
      rolledRequests: 0,
      rolledTurns: 0,
      rolledTools: 0,
      deletedRequests: 0,
      deletedTurns: 0,
      deletedTools: 0,
    }
    const days = Math.floor(options.detailDays)
    if (!Number.isFinite(days) || days <= 0) return counts
    const now = options.now ?? new Date()
    const cutoffDay = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    const cutoffTs = `${cutoffDay}T00:00:00.000Z`
    const updatedAt = now.toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const requestRows = this.db.prepare(`
        SELECT date(created_at) AS day, agent_id, provider_id, model_id, source, status, modality,
          cost_currency AS currency,
          COALESCE(SUM(request_count), 0) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(cost_total), 0) AS cost_total,
          COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END), 0) AS duration_sum,
          COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS duration_n,
          COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL THEN first_token_ms ELSE 0 END), 0) AS first_token_sum,
          COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS first_token_n
        FROM usage_request WHERE created_at < ?
        GROUP BY day, agent_id, provider_id, model_id, source, status, modality, currency
      `).all(cutoffTs) as Record<string, unknown>[]
      const upsertRequest = this.db.prepare(`
        INSERT INTO usage_rollup (
          id, day, agent_id, provider_id, model_id, source, status, modality, currency,
          requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, cost_total, duration_sum, duration_n, first_token_sum,
          first_token_n, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          requests = requests + excluded.requests,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
          reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
          cost_total = cost_total + excluded.cost_total,
          duration_sum = duration_sum + excluded.duration_sum,
          duration_n = duration_n + excluded.duration_n,
          first_token_sum = first_token_sum + excluded.first_token_sum,
          first_token_n = first_token_n + excluded.first_token_n,
          updated_at = excluded.updated_at
      `)
      for (const row of requestRows) {
        const id = [
          row.day,
          row.agent_id ?? '',
          row.provider_id ?? '',
          row.model_id ?? '',
          row.source,
          row.status,
          row.modality,
          row.currency ?? '',
        ].join('|')
        upsertRequest.run(
          id,
          String(row.day),
          (row.agent_id ?? null) as string | null,
          (row.provider_id ?? null) as string | null,
          (row.model_id ?? null) as string | null,
          String(row.source),
          String(row.status),
          String(row.modality),
          (row.currency ?? null) as string | null,
          asNumber(row.requests),
          asNumber(row.input_tokens),
          asNumber(row.output_tokens),
          asNumber(row.cache_read_tokens),
          asNumber(row.cache_write_tokens),
          asNumber(row.reasoning_tokens),
          asNumber(row.cost_total),
          asNumber(row.duration_sum),
          asNumber(row.duration_n),
          asNumber(row.first_token_sum),
          asNumber(row.first_token_n),
          updatedAt,
        )
        counts.rolledRequests += asNumber(row.requests)
      }
      counts.deletedRequests = Number(
        this.db.prepare('DELETE FROM usage_request WHERE created_at < ?').run(cutoffTs).changes,
      )

      const turnRows = this.db.prepare(`
        SELECT date(created_at) AS day, agent_id, provider_id, model_id, status,
          cost_currency AS currency,
          COUNT(*) AS turns, COALESCE(SUM(steps), 0) AS steps,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(cost_total), 0) AS cost_total
        FROM usage_turn WHERE created_at < ?
        GROUP BY day, agent_id, provider_id, model_id, status, currency
      `).all(cutoffTs) as Record<string, unknown>[]
      const upsertTurn = this.db.prepare(`
        INSERT INTO usage_rollup_turn (
          id, day, agent_id, provider_id, model_id, status, currency,
          turns, steps, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens, cost_total, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          turns = turns + excluded.turns,
          steps = steps + excluded.steps,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
          reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
          cost_total = cost_total + excluded.cost_total,
          updated_at = excluded.updated_at
      `)
      for (const row of turnRows) {
        const id = [
          row.day,
          row.agent_id ?? '',
          row.provider_id ?? '',
          row.model_id ?? '',
          row.status,
          row.currency ?? '',
        ].join('|')
        upsertTurn.run(
          id,
          String(row.day),
          (row.agent_id ?? null) as string | null,
          (row.provider_id ?? null) as string | null,
          (row.model_id ?? null) as string | null,
          String(row.status),
          (row.currency ?? null) as string | null,
          asNumber(row.turns),
          asNumber(row.steps),
          asNumber(row.input_tokens),
          asNumber(row.output_tokens),
          asNumber(row.cache_read_tokens),
          asNumber(row.cache_write_tokens),
          asNumber(row.reasoning_tokens),
          asNumber(row.cost_total),
          updatedAt,
        )
        counts.rolledTurns += asNumber(row.turns)
      }
      counts.deletedTurns = Number(
        this.db.prepare('DELETE FROM usage_turn WHERE created_at < ?').run(cutoffTs).changes,
      )

      const toolRows = this.db.prepare(`
        SELECT substr(updated_at, 1, 10) AS day, agent_id, tool_name,
          COALESCE(SUM(calls), 0) AS calls,
          COALESCE(SUM(errors), 0) AS errors,
          COALESCE(SUM(duration_ms), 0) AS duration_ms
        FROM usage_tool WHERE updated_at < ?
        GROUP BY day, agent_id, tool_name
      `).all(cutoffTs) as Record<string, unknown>[]
      const upsertTool = this.db.prepare(`
        INSERT INTO usage_rollup_tool (
          id, day, agent_id, tool_name, calls, errors, duration_ms, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          calls = calls + excluded.calls,
          errors = errors + excluded.errors,
          duration_ms = duration_ms + excluded.duration_ms,
          updated_at = excluded.updated_at
      `)
      for (const row of toolRows) {
        const id = [row.day, row.agent_id ?? '', row.tool_name].join('|')
        upsertTool.run(
          id,
          String(row.day),
          (row.agent_id ?? null) as string | null,
          String(row.tool_name),
          asNumber(row.calls),
          asNumber(row.errors),
          asNumber(row.duration_ms),
          updatedAt,
        )
        counts.rolledTools += asNumber(row.calls)
      }
      counts.deletedTools = Number(
        this.db.prepare('DELETE FROM usage_tool WHERE updated_at < ?').run(cutoffTs).changes,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务没起来就不用回滚；不掩盖原始错误。
      }
      throw error
    }
    return counts
  }

  /** 区间总览：聚合 + 活跃日 / 连胜 / 峰值 / 头部模型等派生指标。 */
  overview(filter: UsageFilter = {}, options: { timeZone?: UsageTimeZone } = {}): UsageOverview {
    const utc = options.timeZone === 'utc'
    const where = requestWhere(filter)
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(request_count), 0) AS requests,
        ${TOKEN_SUMS},
        COALESCE(SUM(cost_total), 0) AS cost_total,
        COALESCE(SUM(CASE WHEN cost_priced = 0 THEN request_count ELSE 0 END), 0) AS unpriced,
        COALESCE(SUM(CASE WHEN status IN ('failed', 'cancelled')
          THEN request_count ELSE 0 END), 0) AS failed,
        AVG(first_token_ms) AS avg_first_token_ms,
        AVG(duration_ms) AS avg_duration_ms,
        COALESCE(SUM(CASE WHEN duration_ms > 0 THEN output_tokens ELSE 0 END), 0) AS output_for_tps,
        COALESCE(SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END), 0) AS duration_for_tps
      FROM usage_all ${where.sql}
    `).get(...where.params) as Record<string, unknown>

    const turnsFilter = turnWhere(filter)
    const turnsRow = this.db.prepare(
      `SELECT COALESCE(SUM(row_count), 0) AS n FROM usage_turn_all ${turnsFilter.sql}`,
    ).get(...turnsFilter.params) as { n: number } | undefined

    const currencies = this.db.prepare(`
      SELECT COALESCE(cost_currency, '') AS currency, COALESCE(SUM(cost_total), 0) AS total
      FROM usage_all ${where.sql} AND cost_priced = 1
      GROUP BY currency HAVING total > 0
      ORDER BY total DESC
    `).all(...where.params) as Record<string, unknown>[]

    const dayExpr = utc ? 'date(created_at)' : "date(created_at, 'localtime')"
    const dayRows = this.db.prepare(`
      SELECT ${dayExpr} AS day, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM usage_all ${where.sql}
      GROUP BY day ORDER BY day
    `).all(...where.params) as Record<string, unknown>[]
    const days = dayRows.map(day => String(day.day))
    let peakDay: { date: string; tokens: number } | undefined
    for (const day of dayRows) {
      const tokens = asNumber(day.tokens)
      if (!peakDay || tokens > peakDay.tokens) peakDay = { date: String(day.day), tokens }
    }

    const topModel = this.db.prepare(`
      SELECT provider_id, model_id,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
        COALESCE(SUM(cost_total), 0) AS cost
      FROM usage_all ${where.sql} AND model_id IS NOT NULL
      GROUP BY provider_id, model_id ORDER BY tokens DESC LIMIT 1
    `).get(...where.params) as Record<string, unknown> | undefined

    const tokens = totalsFrom(row)
    const requests = asNumber(row.requests)
    const activeDays = days.length
    const inputPlusCache = tokens.input + tokens.cacheRead
    const durationForTps = asNumber(row.duration_for_tps)
    const tps = durationForTps > 0 ? asNumber(row.output_for_tps) / (durationForTps / 1000) : undefined
    const avgFirstTokenMs = typeof row.avg_first_token_ms === 'number' ? row.avg_first_token_ms : undefined
    const avgDurationMs = typeof row.avg_duration_ms === 'number' ? row.avg_duration_ms : undefined
    return {
      requests,
      turns: turnsRow?.n ?? 0,
      tokens,
      costTotal: asNumber(row.cost_total),
      costByCurrency: currencies.map(entry => ({
        currency: String(entry.currency),
        total: asNumber(entry.total),
      })),
      unpricedRequests: asNumber(row.unpriced),
      failedRequests: asNumber(row.failed),
      // 分母用「输入 + 缓存读」：各家 input 是否含缓存读语义不一，这样恒有界。
      cacheHitRate: inputPlusCache > 0 ? tokens.cacheRead / inputPlusCache : 0,
      activeDays,
      longestStreak: streakOf(days),
      ...(peakDay ? { peakDay } : {}),
      ...(topModel
        ? {
          topModel: {
            ...(asString(topModel.provider_id) ? { providerId: String(topModel.provider_id) } : {}),
            ...(asString(topModel.model_id) ? { modelId: String(topModel.model_id) } : {}),
            tokens: asNumber(topModel.tokens),
            cost: asNumber(topModel.cost),
          },
        }
        : {}),
      dailyAverage: {
        tokens: activeDays > 0 ? tokens.total / activeDays : 0,
        requests: activeDays > 0 ? requests / activeDays : 0,
      },
      ...(avgFirstTokenMs !== undefined ? { avgFirstTokenMs } : {}),
      ...(avgDurationMs !== undefined ? { avgDurationMs } : {}),
      ...(tps !== undefined && Number.isFinite(tps) ? { tps } : {}),
    }
  }

  /** 时间序列；同一 bucket 出现多币种时按 currency 拆成多行，由前端归并。 */
  timeline(
    filter: UsageFilter = {},
    options: { bucket?: UsageBucket; timeZone?: UsageTimeZone } = {},
  ): readonly UsageTimelinePoint[] {
    const utc = options.timeZone === 'utc'
    const expr = bucketExpr(options.bucket ?? 'day', utc)
    const where = requestWhere(filter)
    const rows = this.db.prepare(`
      SELECT ${expr} AS bucket,
        COALESCE(SUM(request_count), 0) AS requests,
        ${TOKEN_SUMS},
        COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(cost_currency, '') AS currency
      FROM usage_all ${where.sql}
      GROUP BY bucket, currency ORDER BY bucket
    `).all(...where.params) as Record<string, unknown>[]
    return rows.map(row => ({
      bucket: String(row.bucket),
      requests: asNumber(row.requests),
      tokens: totalsFrom(row),
      cost: asNumber(row.cost),
      ...(asString(row.currency) ? { currency: String(row.currency) } : {}),
    }))
  }

  /** 分组排行；groupBy = 'tool' 走工具表，token/成本为 0。 */
  groups(
    filter: UsageFilter = {},
    options: { groupBy: UsageGroupBy; limit?: number },
  ): readonly UsageGroupRow[] {
    const limit = clampInt(options.limit, 200, 1, 1000)
    if (options.groupBy === 'tool') {
      const where = toolWhere(filter)
      const rows = this.db.prepare(`
        SELECT tool_name,
          COALESCE(SUM(calls), 0) AS calls,
          COALESCE(SUM(errors), 0) AS errors,
          COALESCE(SUM(duration_ms), 0) AS duration_ms
        FROM usage_tool_all ${where.sql}
        GROUP BY tool_name ORDER BY calls DESC LIMIT ?
      `).all(...where.params, limit) as Record<string, unknown>[]
      return rows.map(row => ({
        key: String(row.tool_name),
        label: String(row.tool_name),
        requestCount: asNumber(row.calls),
        tokens: emptyTotals(),
        cost: 0,
        toolErrors: asNumber(row.errors),
        toolDurationMs: asNumber(row.duration_ms),
      }))
    }
    const dim = GROUP_COLUMNS[options.groupBy]
    const where = requestWhere(filter)
    const cols = dim.cols.map((column, index) => `${column} AS c${index}`).join(', ')
    const rows = this.db.prepare(`
      SELECT ${cols}, ${dim.label} AS label,
        COALESCE(SUM(request_count), 0) AS requests,
        ${TOKEN_SUMS},
        COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(cost_currency, '') AS currency
      FROM usage_all ${where.sql}
      GROUP BY ${dim.cols.join(', ')}, currency
      ORDER BY requests DESC LIMIT ?
    `).all(...where.params, limit) as Record<string, unknown>[]
    return rows.map(row => groupRowFrom(options.groupBy as Exclude<UsageGroupBy, 'tool'>, row))
  }

  /** 请求明细分页，按时间倒序。 */
  requests(
    filter: UsageFilter = {},
    options: { limit?: number; offset?: number } = {},
  ): UsageRequestPage {
    const limit = clampInt(options.limit, 50, 1, 500)
    const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const where = requestWhere(filter)
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS n FROM usage_request ${where.sql}`,
    ).get(...where.params) as { n: number } | undefined
    const rows = this.db.prepare(
      `SELECT * FROM usage_request ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...where.params, limit, offset) as Record<string, unknown>[]
    return {
      rows: rows.map(requestRowFrom),
      total: totalRow?.n ?? 0,
      offset,
      limit,
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // close 失败不影响调用方
    }
  }
}
