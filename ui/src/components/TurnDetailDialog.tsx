import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  formatCost,
  formatElapsed,
  formatPercent,
  formatSpeed,
  formatTokens,
} from '../lib/format'
import type { TurnCost, UiTimelineItem } from '../types'
import { Icon } from './Icon'

function Metric({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="fw-usage-metric">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function DistributionRow({
  label,
  value,
  total,
  tone,
  detail,
}: {
  label: string
  value: number
  total: number
  tone: 'accent' | 'mint' | 'warn' | 'muted'
  detail?: string
}) {
  const width = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0
  return (
    <div className="fw-usage-dist-row">
      <div className="fw-usage-dist-head">
        <span>{label}</span>
        <b>{detail ?? formatTokens(value)}</b>
      </div>
      <div className="fw-usage-dist-track">
        <span className={`fw-usage-dist-fill is-${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

function periodLabel(period: TurnCost['period'] | undefined): string {
  if (period === 'standard') return '标准价'
  if (period === 'offPeak') return '低谷价'
  if (period === 'mixed') return '标准/高峰 + 低谷'
  return '高峰价'
}

export function TurnDetailDialog({
  item,
  onClose,
}: {
  item: UiTimelineItem
  onClose: () => void
}) {
  const usage = item.turnUsage
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!usage) return null

  const input = usage.usage.input
  const cacheRead = usage.usage.cacheRead
  const output = usage.usage.output
  const uncachedInput = Math.max(0, input - cacheRead)
  const totalTokens = uncachedInput + cacheRead + output
  const cost = usage.cost
  const costTotal = cost?.total ?? 0
  const totalDuration = usage.durationMs ?? 0
  const modelDuration = usage.modelDurationMs ?? 0
  const toolDuration = usage.toolDurationMs ?? 0
  const otherDuration = Math.max(0, totalDuration - modelDuration - toolDuration)
  const timeTotal = Math.max(totalDuration, modelDuration + toolDuration)
  const modelLabel = usage.model
    ? `${usage.model.provider} / ${usage.model.model}`
    : '未记录'

  return createPortal(
    <div className="fw-modal-backdrop" onMouseDown={onClose}>
      <div
        className="fw-usage-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="本轮用量"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <div>
            <h2>本轮用量</h2>
            <p className="fw-usage-model">{modelLabel}</p>
          </div>
          <button
            type="button"
            className="fw-icon-btn"
            onClick={onClose}
            aria-label="关闭用量明细"
            title="关闭用量明细"
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="fw-usage-body">
          <div className="fw-usage-metrics">
            <Metric label="总 token" value={formatTokens(input + output)} />
            <Metric label="速度" value={formatSpeed(output, usage.modelDurationMs)} />
            <Metric
              label="金额"
              value={formatCost(costTotal, cost?.currency ?? null)}
            />
            <Metric label="耗时" value={formatElapsed(totalDuration) || '0'} />
          </div>

          <section className="fw-usage-section">
            <div className="fw-usage-section-head">
              <h3>Token 构成</h3>
              <span>缓存命中属于输入的子集</span>
            </div>
            <div className="fw-usage-stack">
              {uncachedInput > 0 && (
                <span
                  className="is-input"
                  style={{ width: `${(uncachedInput / Math.max(1, totalTokens)) * 100}%` }}
                />
              )}
              {cacheRead > 0 && (
                <span
                  className="is-cache"
                  style={{ width: `${(cacheRead / Math.max(1, totalTokens)) * 100}%` }}
                />
              )}
              {output > 0 && (
                <span
                  className="is-output"
                  style={{ width: `${(output / Math.max(1, totalTokens)) * 100}%` }}
                />
              )}
            </div>
            <div className="fw-usage-dist">
              <DistributionRow
                label="未命中输入"
                value={uncachedInput}
                total={totalTokens}
                tone="accent"
                detail={`${formatTokens(uncachedInput)} · ${formatPercent(uncachedInput, totalTokens)}`}
              />
              <DistributionRow
                label="缓存命中"
                value={cacheRead}
                total={totalTokens}
                tone="mint"
                detail={`${formatTokens(cacheRead)} · ${formatPercent(cacheRead, totalTokens)}`}
              />
              <DistributionRow
                label="输出"
                value={output}
                total={totalTokens}
                tone="warn"
                detail={`${formatTokens(output)} · ${formatPercent(output, totalTokens)}`}
              />
            </div>
          </section>

          <section className="fw-usage-section">
            <div className="fw-usage-section-head">
              <h3>金额分布</h3>
              <span>{cost?.priced ? periodLabel(cost.period) : '未配置单价，按 0 计'}</span>
            </div>
            <div className="fw-usage-dist">
              <DistributionRow
                label="输入"
                value={cost?.input ?? 0}
                total={costTotal}
                tone="accent"
                detail={formatCost(cost?.input ?? 0, cost?.currency ?? null)}
              />
              <DistributionRow
                label="缓存命中"
                value={cost?.cacheRead ?? 0}
                total={costTotal}
                tone="mint"
                detail={formatCost(cost?.cacheRead ?? 0, cost?.currency ?? null)}
              />
              <DistributionRow
                label="输出"
                value={cost?.output ?? 0}
                total={costTotal}
                tone="warn"
                detail={formatCost(cost?.output ?? 0, cost?.currency ?? null)}
              />
            </div>
            <div className="fw-usage-total">
              <span>合计</span>
              <b>{formatCost(costTotal, cost?.currency ?? null)}</b>
            </div>
          </section>

          <section className="fw-usage-section">
            <div className="fw-usage-section-head">
              <h3>时间分布</h3>
              <span>总耗时 {formatElapsed(totalDuration) || '0'}</span>
            </div>
            <div className="fw-usage-stack is-time">
              {modelDuration > 0 && (
                <span
                  className="is-model"
                  style={{ width: `${(modelDuration / Math.max(1, timeTotal)) * 100}%` }}
                />
              )}
              {toolDuration > 0 && (
                <span
                  className="is-tool"
                  style={{ width: `${(toolDuration / Math.max(1, timeTotal)) * 100}%` }}
                />
              )}
              {otherDuration > 0 && (
                <span
                  className="is-other"
                  style={{ width: `${(otherDuration / Math.max(1, timeTotal)) * 100}%` }}
                />
              )}
            </div>
            <div className="fw-usage-dist">
              <DistributionRow
                label="模型"
                value={modelDuration}
                total={timeTotal}
                tone="accent"
                detail={formatElapsed(modelDuration) || '0'}
              />
              <DistributionRow
                label="工具 / 审批"
                value={toolDuration}
                total={timeTotal}
                tone="mint"
                detail={formatElapsed(toolDuration) || '0'}
              />
              <DistributionRow
                label="其他"
                value={otherDuration}
                total={timeTotal}
                tone="muted"
                detail={formatElapsed(otherDuration) || '0'}
              />
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}