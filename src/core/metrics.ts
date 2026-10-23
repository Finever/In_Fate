/**
 * 进程内指标：计数器、直方图、仪表。
 *
 * 不引外部依赖，不落盘；给 CLI、UI API 和排障时看当下状态用。
 * 标签按排序后的 key/value 归并，保证同名不同标签不会互相覆盖。
 *
 * @module if/core/metrics
 */

export type MetricLabels = Readonly<Record<string, string | number>>

export interface CounterMetric {
  readonly name: string
  readonly labels?: MetricLabels
  readonly value: number
}

export interface HistogramMetric {
  readonly name: string
  readonly labels?: MetricLabels
  readonly count: number
  readonly sum: number
  readonly min: number
  readonly max: number
}

export interface GaugeMetric {
  readonly name: string
  readonly labels?: MetricLabels
  readonly value: number
}

export interface MetricsSnapshot {
  readonly startedAt: string
  readonly counters: readonly CounterMetric[]
  readonly histograms: readonly HistogramMetric[]
  readonly gauges: readonly GaugeMetric[]
}

interface HistogramState {
  readonly name: string
  readonly labels?: MetricLabels
  count: number
  sum: number
  min: number
  max: number
}

function keyOf(name: string, labels: MetricLabels | undefined): string {
  if (!labels) return name
  const entries = Object.entries(labels)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  return `${name}\u0000${JSON.stringify(entries)}`
}

export class Metrics {
  readonly startedAt = new Date().toISOString()
  private readonly counters = new Map<string, CounterMetric>()
  private readonly histograms = new Map<string, HistogramState>()
  private readonly gauges = new Map<string, GaugeMetric>()

  inc(name: string, value = 1, labels?: MetricLabels): void {
    const key = keyOf(name, labels)
    const current = this.counters.get(key)
    this.counters.set(key, {
      name,
      ...(labels ? { labels } : {}),
      value: (current?.value ?? 0) + value,
    })
  }

  observe(name: string, value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value)) return
    const key = keyOf(name, labels)
    const current = this.histograms.get(key)
    if (current) {
      current.count += 1
      current.sum += value
      current.min = Math.min(current.min, value)
      current.max = Math.max(current.max, value)
      return
    }
    this.histograms.set(key, {
      name,
      ...(labels ? { labels } : {}),
      count: 1,
      sum: value,
      min: value,
      max: value,
    })
  }

  set(name: string, value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value)) return
    this.gauges.set(keyOf(name, labels), {
      name,
      ...(labels ? { labels } : {}),
      value,
    })
  }

  snapshot(): MetricsSnapshot {
    const sort = <T extends { name: string }>(items: T[]): T[] =>
      items.sort((a, b) => a.name.localeCompare(b.name) || JSON.stringify(a).localeCompare(JSON.stringify(b)))

    return {
      startedAt: this.startedAt,
      counters: sort([...this.counters.values()].map(item => ({ ...item }))),
      histograms: sort([...this.histograms.values()].map(item => ({ ...item }))),
      gauges: sort([...this.gauges.values()].map(item => ({ ...item }))),
    }
  }
}
