import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type UsageQueryParams } from '../api'
import { formatCost, formatDateTime, formatDuration, formatTokens, shortId } from '../lib/format'
import type {
  UsageBucket,
  UsageGroupBy,
  UsageGroupRow,
  UsageLedgerStats,
  UsageOverview,
  UsageRequestPage,
  UsageRequestRow,
  UsageTimelinePoint,
} from '../types'
import { EChart } from './EChart'
import { Icon } from './Icon'

type RangeKey = '7' | '30' | '90' | 'all'
type TabKey = 'overview' | 'groups' | 'requests'
type PricedKey = 'all' | 'priced' | 'unpriced'

interface UsageFilterState {
  modelId: string
  providerId: string
  agentId: string
  sessionId: string
  apiKeyId: string
  source: string
  status: string
  modality: string
  priced: PricedKey
}

const EMPTY_FILTER: UsageFilterState = {
  modelId: '',
  providerId: '',
  agentId: '',
  sessionId: '',
  apiKeyId: '',
  source: '',
  status: '',
  modality: '',
  priced: 'all',
}

const RANGES: Array<{ id: RangeKey; label: string }> = [
  { id: '7', label: '近 7 天' },
  { id: '30', label: '近 30 天' },
  { id: '90', label: '近 90 天' },
  { id: 'all', label: '全部' },
]

const BUCKETS: Array<{ id: UsageBucket | 'auto'; label: string }> = [
  { id: 'auto', label: '自动' },
  { id: 'hour', label: '小时' },
  { id: 'day', label: '天' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
]

const DIMENSIONS: Array<{ id: UsageGroupBy; label: string }> = [
  { id: 'model', label: '模型' },
  { id: 'agent', label: 'Agent' },
  { id: 'provider', label: '服务商' },
  { id: 'key', label: '密钥' },
  { id: 'source', label: '来源' },
  { id: 'session', label: '会话' },
  { id: 'tool', label: '工具' },
  { id: 'status', label: '状态' },
]

const SOURCE_LABELS: Record<string, string> = {
  user: '用户',
  agent: 'Agent',
  subagent: '子 Agent',
  unknown: '未知',
}

const STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  waiting: '等待',
}

const CHART_COLORS = {
  input: '#6cc7ff',
  output: '#5fe3c0',
  cache: '#8f7bff',
  requests: '#f2b45f',
  cost: ['#8f7bff', '#5fe3c0', '#f2b45f', '#ff6b7d', '#6cc7ff'],
}

const PAGE_SIZE = 50

function localDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function rangeParams(range: RangeKey): UsageQueryParams {
  if (range === 'all') return {}
  const days = Number(range)
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  const to = new Date()
  to.setDate(to.getDate() + 1)
  return { from: localDate(from), to: localDate(to) }
}

function autoBucket(range: RangeKey): UsageBucket {
  switch (range) {
    case '7': return 'day'
    case '30': return 'day'
    case '90': return 'week'
    default: return 'month'
  }
}

type ReportKind = 'week' | 'month' | 'year'

interface ReportState {
  kind: ReportKind
  /** 这一期的起始日（周一 / 1 号 / 1 月 1 日），本地时间。 */
  start: Date
}

const REPORTS: Array<{ id: ReportKind; label: string }> = [
  { id: 'week', label: '周报告' },
  { id: 'month', label: '月报告' },
  { id: 'year', label: '年报告' },
]

/** ISO 周：周一为一周之始。 */
function isoWeekInfo(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const isoYear = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { year: isoYear, week }
}

function periodStart(kind: ReportKind, date: Date): Date {
  if (kind === 'week') {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d
  }
  if (kind === 'month') return new Date(date.getFullYear(), date.getMonth(), 1)
  return new Date(date.getFullYear(), 0, 1)
}

function periodEndInclusive(kind: ReportKind, start: Date): Date {
  if (kind === 'week') {
    const d = new Date(start)
    d.setDate(d.getDate() + 6)
    return d
  }
  if (kind === 'month') return new Date(start.getFullYear(), start.getMonth() + 1, 0)
  return new Date(start.getFullYear(), 11, 31)
}

function shiftPeriod(kind: ReportKind, start: Date, delta: number): Date {
  if (kind === 'week') {
    const d = new Date(start)
    d.setDate(d.getDate() + delta * 7)
    return d
  }
  if (kind === 'month') return new Date(start.getFullYear(), start.getMonth() + delta, 1)
  return new Date(start.getFullYear() + delta, 0, 1)
}

function mmdd(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function periodLabel(kind: ReportKind, start: Date): string {
  if (kind === 'week') {
    const { year, week } = isoWeekInfo(start)
    return `${year} 年 第 ${week} 周 · ${mmdd(start)} ~ ${mmdd(periodEndInclusive(kind, start))}`
  }
  if (kind === 'month') return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`
  return `${start.getFullYear()} 年`
}

interface TimelineBucket {
  bucket: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cost: Map<string, number>
}

/** 时间线按 bucket 归并；同一 bucket 的多币种行只影响费用，请求/token 直接累加。 */
function mergeTimeline(points: UsageTimelinePoint[]): TimelineBucket[] {
  const map = new Map<string, TimelineBucket>()
  for (const point of points) {
    let entry = map.get(point.bucket)
    if (!entry) {
      entry = {
        bucket: point.bucket,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cost: new Map(),
      }
      map.set(point.bucket, entry)
    }
    entry.requests += point.requests
    entry.input += point.tokens.input
    entry.output += point.tokens.output
    entry.cacheRead += point.tokens.cacheRead
    if (point.currency && point.cost > 0) {
      entry.cost.set(point.currency, (entry.cost.get(point.currency) ?? 0) + point.cost)
    }
  }
  return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
}

function axisLabel(value: string): string {
  if (value.includes(' ')) return value.slice(5)
  return value.length > 7 ? value.slice(2) : value.slice(5)
}

function tokensChartOption(buckets: TimelineBucket[]): object {
  return {
    grid: { left: 56, right: 56, top: 30, bottom: 26 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { color: '#8b95a8', fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: buckets.map(entry => entry.bucket),
      axisLabel: { color: '#8b95a8', fontSize: 10, formatter: axisLabel },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,.14)' } },
    },
    yAxis: [
      {
        type: 'value',
        name: 'token',
        nameTextStyle: { color: '#5d687c', fontSize: 10 },
        axisLabel: { color: '#8b95a8', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } },
      },
      {
        type: 'value',
        name: '请求',
        nameTextStyle: { color: '#5d687c', fontSize: 10 },
        axisLabel: { color: '#8b95a8', fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '输入',
        type: 'bar',
        stack: 'tokens',
        data: buckets.map(entry => entry.input),
        itemStyle: { color: CHART_COLORS.input },
        barMaxWidth: 18,
      },
      {
        name: '输出',
        type: 'bar',
        stack: 'tokens',
        data: buckets.map(entry => entry.output),
        itemStyle: { color: CHART_COLORS.output },
        barMaxWidth: 18,
      },
      {
        name: '缓存读',
        type: 'bar',
        stack: 'tokens',
        data: buckets.map(entry => entry.cacheRead),
        itemStyle: { color: CHART_COLORS.cache },
        barMaxWidth: 18,
      },
      {
        name: '请求',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 5,
        data: buckets.map(entry => entry.requests),
        itemStyle: { color: CHART_COLORS.requests },
        lineStyle: { color: CHART_COLORS.requests, width: 1.6 },
      },
    ],
  }
}

function costChartOption(buckets: TimelineBucket[]): object {
  const currencies = new Set<string>()
  for (const entry of buckets) {
    for (const currency of entry.cost.keys()) currencies.add(currency)
  }
  return {
    grid: { left: 56, right: 20, top: 30, bottom: 26 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { color: '#8b95a8', fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: buckets.map(entry => entry.bucket),
      axisLabel: { color: '#8b95a8', fontSize: 10, formatter: axisLabel },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,.14)' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8b95a8', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } },
    },
    series: [...currencies].map((currency, index) => ({
      name: currency,
      type: 'line',
      smooth: true,
      symbolSize: 5,
      data: buckets.map(entry => entry.cost.get(currency) ?? 0),
      itemStyle: { color: CHART_COLORS.cost[index % CHART_COLORS.cost.length] },
      lineStyle: { color: CHART_COLORS.cost[index % CHART_COLORS.cost.length], width: 1.6 },
    })),
  }
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function overviewCostText(overview: UsageOverview): string {
  if (overview.costByCurrency.length === 0) return formatCost(0, null)
  return overview.costByCurrency
    .map(entry => formatCost(entry.total, entry.currency || null))
    .join(' · ')
}

export function UsagePanel() {
  const [stats, setStats] = useState<UsageLedgerStats>()
  const [overview, setOverview] = useState<UsageOverview>()
  const [points, setPoints] = useState<UsageTimelinePoint[]>([])
  const [groups, setGroups] = useState<UsageGroupRow[]>([])
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('model')
  const [requests, setRequests] = useState<UsageRequestPage>()
  const [range, setRange] = useState<RangeKey>('30')
  const [report, setReport] = useState<ReportState>()
  const [bucket, setBucket] = useState<UsageBucket | 'auto'>('auto')
  const [tab, setTab] = useState<TabKey>('overview')
  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_FILTER)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const baseParams: UsageQueryParams = useMemo(() => ({
    ...(report
      ? {
        from: localDate(report.start),
        to: localDate(periodEndInclusive(report.kind, report.start)),
      }
      : rangeParams(range)),
    ...(filter.modelId ? { modelId: filter.modelId } : {}),
    ...(filter.providerId ? { providerId: filter.providerId } : {}),
    ...(filter.agentId ? { agentId: filter.agentId } : {}),
    ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
    ...(filter.apiKeyId ? { apiKeyId: filter.apiKeyId } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.modality ? { modality: filter.modality } : {}),
    ...(filter.priced === 'priced' ? { priced: true } : {}),
    ...(filter.priced === 'unpriced' ? { priced: false } : {}),
  }), [range, report, filter])

  // 输入框防抖：参数稳定后再发请求。
  const [query, setQuery] = useState<UsageQueryParams>(baseParams)
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(baseParams), 250)
    return () => window.clearTimeout(timer)
  }, [baseParams])

  useEffect(() => {
    setPage(0)
  }, [query])

  useEffect(() => {
    let cancelled = false
    void api.usageStats()
      .then(next => {
        if (!cancelled) setStats(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const effectiveBucket = bucket === 'auto'
    ? report
      ? report.kind === 'year' ? 'month' : 'day'
      : autoBucket(range)
    : bucket

  const reportCanNext = report !== undefined
    && shiftPeriod(report.kind, report.start, 1).getTime()
      <= periodStart(report.kind, new Date()).getTime()

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(undefined)
    void Promise.all([
      api.usageOverview(query),
      api.usageTimeline(query, { bucket: effectiveBucket }),
    ])
      .then(([nextOverview, nextPoints]) => {
        if (cancelled) return
        setOverview(nextOverview)
        setPoints(nextPoints)
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [query, effectiveBucket])

  useEffect(() => {
    if (tab !== 'groups') return
    let cancelled = false
    void api.usageGroups(query, groupBy)
      .then(rows => {
        if (!cancelled) setGroups(rows)
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [tab, query, groupBy])

  useEffect(() => {
    if (tab !== 'requests') return
    let cancelled = false
    void api.usageRequests(query, { limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then(next => {
        if (!cancelled) setRequests(next)
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [tab, query, page])

  const buckets = useMemo(() => mergeTimeline(points), [points])
  const tokensOption = useMemo(() => tokensChartOption(buckets), [buckets])
  const costOption = useMemo(() => costChartOption(buckets), [buckets])

  const activeChips = useMemo(() => {
    const chips: Array<{ key: keyof UsageFilterState; label: string; value: string }> = []
    const add = (key: keyof UsageFilterState, label: string, value: string): void => {
      if (value) chips.push({ key, label, value })
    }
    add('modelId', '模型', filter.modelId)
    add('providerId', '服务商', filter.providerId)
    add('agentId', 'Agent', filter.agentId)
    add('sessionId', '会话', filter.sessionId)
    add('apiKeyId', '密钥', filter.apiKeyId)
    add('source', '来源', SOURCE_LABELS[filter.source] ?? filter.source)
    add('status', '状态', STATUS_LABELS[filter.status] ?? filter.status)
    add('modality', '类型', filter.modality)
    if (filter.priced !== 'all') {
      chips.push({
        key: 'priced',
        label: '计价',
        value: filter.priced === 'priced' ? '已定价' : '未定价',
      })
    }
    return chips
  }, [filter])

  const clearFilter = useCallback((key?: keyof UsageFilterState): void => {
    setFilter(prev => (key ? { ...prev, [key]: key === 'priced' ? 'all' : '' } : EMPTY_FILTER))
  }, [])

  const drillInto = useCallback((row: UsageGroupRow): void => {
    switch (groupBy) {
      case 'model':
        setFilter(prev => ({
          ...prev,
          modelId: row.modelId ?? '',
          providerId: row.providerId ?? '',
        }))
        break
      case 'provider':
        setFilter(prev => ({ ...prev, providerId: row.providerId ?? '' }))
        break
      case 'agent':
        setFilter(prev => ({ ...prev, agentId: row.agentId ?? '' }))
        break
      case 'session':
        setFilter(prev => ({ ...prev, sessionId: row.sessionId ?? '' }))
        break
      case 'key':
        setFilter(prev => ({ ...prev, apiKeyId: row.apiKeyId ?? '' }))
        break
      case 'source':
        setFilter(prev => ({ ...prev, source: row.source ?? '' }))
        break
      case 'status':
        setFilter(prev => ({ ...prev, status: row.status ?? '' }))
        break
      case 'modality':
        setFilter(prev => ({ ...prev, modality: row.modality ?? '' }))
        break
      default:
        break
    }
  }, [groupBy])

  const exportCsv = useCallback(async (): Promise<void> => {
    setExporting(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const rows: UsageRequestRow[] = []
      const cap = 5000
      let offset = 0
      for (;;) {
        const data = await api.usageRequests(query, { limit: 500, offset })
        rows.push(...data.rows)
        offset += data.rows.length
        if (rows.length >= cap || offset >= data.total || data.rows.length === 0) break
      }
      if (rows.length > cap) rows.length = cap
      const header = [
        '时间', 'Agent', '来源', '服务商', '模型', '密钥', '状态', '请求数',
        '输入', '输出', '缓存读', '缓存写', '费用', '币种', '已计价',
        '首token(ms)', '时长(ms)', '会话', '轮次', '错误',
      ]
      const lines = [header.join(',')]
      for (const row of rows) {
        lines.push([
          row.createdAt,
          row.agentId ?? '',
          SOURCE_LABELS[row.source] ?? row.source,
          row.providerId ?? '',
          row.modelId ?? '',
          row.apiKeyLabel ?? row.apiKeyMasked ?? '',
          STATUS_LABELS[row.status] ?? row.status,
          row.requestCount,
          row.tokens.input,
          row.tokens.output,
          row.tokens.cacheRead,
          row.tokens.cacheWrite,
          row.cost,
          row.currency ?? '',
          row.priced ? '是' : '否',
          row.firstTokenMs ?? '',
          row.durationMs ?? '',
          row.sessionId,
          row.turn ?? '',
          row.error ?? '',
        ].map(csvCell).join(','))
      }
      const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `if-usage-${localDate(new Date())}.csv`
      link.click()
      URL.revokeObjectURL(url)
      setNotice(`已导出 ${rows.length} 条${rows.length >= cap ? '（上限 5000）' : ''}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExporting(false)
    }
  }, [query])

  const cards = overview
    ? [
      { label: '请求次数', value: formatTokens(overview.requests), hint: `${overview.turns} 轮对话` },
      {
        label: 'Token 总量',
        value: formatTokens(overview.tokens.total),
        hint: `输入 ${formatTokens(overview.tokens.input)} · 输出 ${formatTokens(overview.tokens.output)} · 缓存读 ${formatTokens(overview.tokens.cacheRead)}`,
      },
      {
        label: '费用',
        value: overviewCostText(overview),
        hint: overview.unpricedRequests > 0 ? `${overview.unpricedRequests} 次未定价` : '全部已定价',
      },
      {
        label: '缓存命中率',
        value: `${(overview.cacheHitRate * 100).toFixed(1)}%`,
        hint: `缓存读 ${formatTokens(overview.tokens.cacheRead)}`,
      },
      {
        label: '平均首 token',
        value: formatDuration(overview.avgFirstTokenMs) || '—',
        hint: `平均时长 ${formatDuration(overview.avgDurationMs) || '—'}`,
      },
      {
        label: '生成速度',
        value: overview.tps ? `${overview.tps.toFixed(1)} tok/s` : '—',
        hint: '输出 token ÷ 模型耗时',
      },
      {
        label: '活跃天数',
        value: String(overview.activeDays),
        hint: `最长连续 ${overview.longestStreak} 天`,
      },
      {
        label: '日均',
        value: formatTokens(Math.round(overview.dailyAverage.tokens)),
        hint: `日均请求 ${overview.dailyAverage.requests.toFixed(1)}`,
      },
      {
        label: '峰值日',
        value: overview.peakDay ? formatTokens(overview.peakDay.tokens) : '—',
        hint: overview.peakDay?.date ?? '',
      },
      {
        label: '头部模型',
        value: overview.topModel?.modelId ?? '—',
        hint: overview.topModel ? `${formatTokens(overview.topModel.tokens)} tokens` : '',
      },
      {
        label: '失败请求',
        value: String(overview.failedRequests),
        hint: '失败 + 取消',
      },
    ]
    : []

  const maxGroupRequests = groups.reduce((max, row) => Math.max(max, row.requestCount), 0)

  return (
    <div className="fw-usage">
      <header className="fw-usage-head">
        <div>
          <h3>用量统计</h3>
          <small>
            {stats
              ? [
                `账本 ${formatTokens(stats.requests)} 条请求`,
                `${stats.turns} 轮`,
                `${stats.tools} 组工具`,
                stats.backfillDone ? '已回填' : '',
                stats.rollupRows > 0 && stats.detailSince
                  ? `明细自 ${stats.detailSince.slice(0, 10)} 起，更早的已聚合成日汇总`
                  : '',
              ].filter(Boolean).join(' · ')
              : '载入中'}
          </small>
        </div>
        <div className="fw-usage-controls">
          <div className="fw-usage-range">
            {RANGES.map(option => (
              <button
                key={option.id}
                type="button"
                className={`fw-usage-range-btn${
                  report === undefined && range === option.id ? ' is-active' : ''
                }`}
                onClick={() => {
                  setReport(undefined)
                  setRange(option.id)
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="fw-usage-range">
            {REPORTS.map(option => (
              <button
                key={option.id}
                type="button"
                className={`fw-usage-range-btn${report?.kind === option.id ? ' is-active' : ''}`}
                onClick={() => setReport({
                  kind: option.id,
                  start: periodStart(option.id, new Date()),
                })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {report && (
            <div className="fw-usage-reported">
              <button
                type="button"
                className="fw-usage-nav-btn"
                title="上一期"
                onClick={() => setReport({
                  ...report,
                  start: shiftPeriod(report.kind, report.start, -1),
                })}
              >
                ‹
              </button>
              <span className="fw-usage-period">{periodLabel(report.kind, report.start)}</span>
              <button
                type="button"
                className="fw-usage-nav-btn"
                title="下一期"
                disabled={!reportCanNext}
                onClick={() => setReport({
                  ...report,
                  start: shiftPeriod(report.kind, report.start, 1),
                })}
              >
                ›
              </button>
            </div>
          )}
          <select
            className="fw-usage-select"
            value={bucket}
            onChange={event => setBucket(event.target.value as UsageBucket | 'auto')}
            title="时间线粒度"
          >
            {BUCKETS.map(option => (
              <option key={option.id} value={option.id}>粒度：{option.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="fw-usage-sync"
            onClick={() => setQuery({ ...baseParams })}
            disabled={busy}
            title="刷新"
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </header>

      <nav className="fw-usage-tabs">
        <button
          type="button"
          className={`fw-usage-tab${tab === 'overview' ? ' is-active' : ''}`}
          onClick={() => setTab('overview')}
        >
          概览
        </button>
        <button
          type="button"
          className={`fw-usage-tab${tab === 'groups' ? ' is-active' : ''}`}
          onClick={() => setTab('groups')}
        >
          分组
        </button>
        <button
          type="button"
          className={`fw-usage-tab${tab === 'requests' ? ' is-active' : ''}`}
          onClick={() => setTab('requests')}
        >
          明细
        </button>
        {activeChips.length > 0 && (
          <div className="fw-usage-chips">
            {activeChips.map(chip => (
              <button
                key={chip.key}
                type="button"
                className="fw-usage-chip"
                onClick={() => clearFilter(chip.key)}
                title="点击清除该筛选"
              >
                {chip.label} = {chip.value}
                <Icon name="close" size={10} />
              </button>
            ))}
            <button type="button" className="fw-usage-chip is-clear" onClick={() => clearFilter()}>
              清空
            </button>
          </div>
        )}
      </nav>

      {error && <div className="fw-usage-error">{error}</div>}
      {notice && <div className="fw-usage-notice">{notice}</div>}

      {tab === 'overview' && (
        <div className="fw-usage-overview">
          <div className="fw-usage-cards">
            {cards.map(card => (
              <div key={card.label} className="fw-usage-card">
                <span className="fw-usage-card-label">{card.label}</span>
                <b className="fw-usage-card-value" title={card.value}>{card.value}</b>
                <small className="fw-usage-card-hint" title={card.hint}>{card.hint}</small>
              </div>
            ))}
          </div>
          <section className="fw-usage-chart">
            <div className="fw-usage-chart-title">Token 与请求</div>
            {buckets.length === 0
              ? <div className="fw-usage-empty">这个区间还没有用量记录。</div>
              : <EChart option={tokensOption} height={280} />}
          </section>
          <section className="fw-usage-chart">
            <div className="fw-usage-chart-title">费用</div>
            {buckets.length === 0 || !buckets.some(entry => entry.cost.size > 0)
              ? <div className="fw-usage-empty">没有已定价的调用。</div>
              : <EChart option={costOption} height={220} />}
          </section>
        </div>
      )}

      {tab === 'groups' && (
        <div className="fw-usage-groups">
          <div className="fw-usage-dims">
            {DIMENSIONS.map(dimension => (
              <button
                key={dimension.id}
                type="button"
                className={`fw-usage-dim${groupBy === dimension.id ? ' is-active' : ''}`}
                onClick={() => setGroupBy(dimension.id)}
              >
                {dimension.label}
              </button>
            ))}
          </div>
          {groups.length === 0 ? (
            <div className="fw-usage-empty">没有数据。</div>
          ) : (
            <table className="fw-usage-table">
              <thead>
                <tr>
                  <th>{DIMENSIONS.find(item => item.id === groupBy)?.label ?? '项'}</th>
                  <th className="is-num">调用</th>
                  {groupBy === 'tool' ? (
                    <>
                      <th className="is-num">错误</th>
                      <th className="is-num">耗时</th>
                    </>
                  ) : (
                    <>
                      <th className="is-num">输入</th>
                      <th className="is-num">输出</th>
                      <th className="is-num">缓存</th>
                      <th className="is-num">费用</th>
                    </>
                  )}
                  <th className="is-bar">占比</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(row => {
                  const drillable = groupBy !== 'tool'
                  const share = maxGroupRequests > 0 ? row.requestCount / maxGroupRequests : 0
                  return (
                    <tr
                      key={row.key}
                      className={drillable ? 'is-clickable' : ''}
                      onClick={drillable ? () => drillInto(row) : undefined}
                      title={drillable ? '点击筛选到这个项' : row.label}
                    >
                      <td>
                        <span className="fw-usage-label" title={row.label}>{row.label}</span>
                        {groupBy === 'model' && row.providerId && (
                          <small className="fw-usage-sub">{row.providerId}</small>
                        )}
                        {groupBy === 'session' && (
                          <small className="fw-usage-sub">{shortId(row.sessionId ?? row.label)}</small>
                        )}
                      </td>
                      <td className="is-num">{formatTokens(row.requestCount)}</td>
                      {groupBy === 'tool' ? (
                        <>
                          <td className="is-num">{row.toolErrors ?? 0}</td>
                          <td className="is-num">{formatDuration(row.toolDurationMs) || '—'}</td>
                        </>
                      ) : (
                        <>
                          <td className="is-num">{formatTokens(row.tokens.input)}</td>
                          <td className="is-num">{formatTokens(row.tokens.output)}</td>
                          <td className="is-num">{formatTokens(row.tokens.cacheRead)}</td>
                          <td className="is-num">
                            {row.cost > 0 ? formatCost(row.cost, row.currency ?? null) : '—'}
                          </td>
                        </>
                      )}
                      <td className="is-bar">
                        <span className="fw-usage-bar" style={{ width: `${Math.round(share * 100)}%` }} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'requests' && (
        <div className="fw-usage-requests">
          <div className="fw-usage-filters">
            <label>
              状态
              <select
                value={filter.status}
                onChange={event => setFilter(prev => ({ ...prev, status: event.target.value }))}
              >
                <option value="">全部</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              来源
              <select
                value={filter.source}
                onChange={event => setFilter(prev => ({ ...prev, source: event.target.value }))}
              >
                <option value="">全部</option>
                {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              计价
              <select
                value={filter.priced}
                onChange={event => setFilter(prev => ({
                  ...prev,
                  priced: event.target.value as PricedKey,
                }))}
              >
                <option value="all">全部</option>
                <option value="priced">已定价</option>
                <option value="unpriced">未定价</option>
              </select>
            </label>
            <input
              className="fw-usage-input"
              value={filter.modelId}
              placeholder="模型 id"
              onChange={event => setFilter(prev => ({ ...prev, modelId: event.target.value.trim() }))}
            />
            <input
              className="fw-usage-input"
              value={filter.agentId}
              placeholder="agent id"
              onChange={event => setFilter(prev => ({ ...prev, agentId: event.target.value.trim() }))}
            />
            <button
              type="button"
              className="fw-usage-export"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              {exporting ? '导出中…' : '导出 CSV'}
            </button>
          </div>
          {!requests || requests.rows.length === 0 ? (
            <div className="fw-usage-empty">没有符合条件的请求。</div>
          ) : (
            <>
              <table className="fw-usage-table is-detail">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>来源</th>
                    <th>Agent</th>
                    <th>模型</th>
                    <th>密钥</th>
                    <th>状态</th>
                    <th className="is-num">输入</th>
                    <th className="is-num">输出</th>
                    <th className="is-num">缓存</th>
                    <th className="is-num">首 token</th>
                    <th className="is-num">费用</th>
                    <th>会话</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.rows.map(row => (
                    <tr key={row.id}>
                      <td className="is-mono">{formatDateTime(row.createdAt)}</td>
                      <td>{SOURCE_LABELS[row.source] ?? row.source}</td>
                      <td>{row.agentId ?? '—'}</td>
                      <td>
                        <span className="fw-usage-label" title={row.modelId ?? ''}>
                          {row.modelId ?? '—'}
                        </span>
                        {row.recordKind !== 'invocation' && (
                          <small className="fw-usage-sub">聚合 ×{row.requestCount}</small>
                        )}
                      </td>
                      <td title={row.apiKeyId ?? ''}>
                        {row.apiKeyLabel ?? row.apiKeyMasked ?? '—'}
                      </td>
                      <td>
                        <span className={`fw-usage-status is-${row.status}`} title={row.error}>
                          {STATUS_LABELS[row.status] ?? row.status}
                        </span>
                      </td>
                      <td className="is-num">{formatTokens(row.tokens.input)}</td>
                      <td className="is-num">{formatTokens(row.tokens.output)}</td>
                      <td className="is-num">{formatTokens(row.tokens.cacheRead)}</td>
                      <td className="is-num">{formatDuration(row.firstTokenMs) || '—'}</td>
                      <td className="is-num">
                        {row.priced ? formatCost(row.cost, row.currency ?? null) : '未定价'}
                      </td>
                      <td className="is-mono" title={`${row.sessionId} · 第 ${row.turn ?? '—'} 轮`}>
                        {shortId(row.sessionId)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <footer className="fw-usage-pager">
                <span>
                  共 {formatTokens(requests.total)} 条 · 第 {Math.floor(requests.offset / PAGE_SIZE) + 1}
                  {' / '}
                  {Math.max(1, Math.ceil(requests.total / PAGE_SIZE))} 页
                </span>
                <div>
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => setPage(prev => Math.max(0, prev - 1))}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={(page + 1) * PAGE_SIZE >= requests.total}
                    onClick={() => setPage(prev => prev + 1)}
                  >
                    下一页
                  </button>
                </div>
              </footer>
            </>
          )}
        </div>
      )}
    </div>
  )
}
