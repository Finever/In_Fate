import { useState } from 'react'
import { formatClock, formatCost, formatSpeed, formatTokens } from '../lib/format'
import type { UiTimelineItem } from '../types'
import { Icon } from './Icon'
import { TurnDetailDialog } from './TurnDetailDialog'

export function TurnMetrics({ item }: { item: UiTimelineItem }) {
  const [open, setOpen] = useState(false)
  const usage = item.turnUsage
  if (!usage) return null

  const cost = usage.cost
  const cache = usage.usage.cacheRead
  const status = item.status === 'cancelled'
    ? '本轮中断'
    : item.status === 'error'
      ? '本轮失败'
      : item.status === 'waiting'
        ? '等待中'
        : '本轮完成'

  return (
    <>
      <button
        type="button"
        className="turn-metrics"
        onClick={() => setOpen(true)}
        aria-label="查看本轮用量"
        title="查看本轮用量"
      >
        <span className="turn-metrics-status">
          <span>{status}</span>
          <span>{formatClock(item.ts)}</span>
        </span>
        <span className="turn-metrics-values">
          <span>输入 {formatTokens(usage.usage.input)}</span>
          <span>输出 {formatTokens(usage.usage.output)}</span>
          {cache > 0 && <span>缓存 {formatTokens(cache)}</span>}
          <span>{formatSpeed(usage.usage.output, usage.modelDurationMs)}</span>
          <span className={cost?.priced ? '' : 'is-zero'}>
            {formatCost(cost?.total ?? 0, cost?.currency ?? null)}
          </span>
        </span>
        <Icon name="chevron" size={13} className="turn-metrics-chevron" />
      </button>

      {open && <TurnDetailDialog item={item} onClose={() => setOpen(false)} />}
    </>
  )
}
