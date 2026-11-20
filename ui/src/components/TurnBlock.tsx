import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TurnCache } from '../cache'
import { formatClock, formatElapsed } from '../lib/format'
import type { UiTimelineItem, UiTurnMeta } from '../types'
import { Icon } from './Icon'
import { ItemCard } from './ItemCard'

function isProcessItem(item: UiTimelineItem): boolean {
  return item.kind === 'thoughts' || item.kind === 'tool' || item.kind === 'compaction'
}

function useLiveElapsed(startedAt: string | undefined, active: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [active, startedAt])
  if (!active || !startedAt) return undefined
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return undefined
  return Math.max(0, now - started)
}

function TurnProcess({
  sessionId,
  items,
  running,
  durationMs,
  startedAt,
}: {
  sessionId: string
  items: UiTimelineItem[]
  running: boolean
  durationMs?: number
  startedAt?: string
}) {
  const processing = running || items.some(item =>
    item.tool?.status === 'running' || item.status === 'running')
  const live = useLiveElapsed(startedAt, processing)
  const shownDuration = processing ? live : durationMs
  const duration = shownDuration !== undefined && shownDuration > 0
    ? formatElapsed(shownDuration)
    : ''

  return (
    <details className="turn-process">
      <summary>
        <span className="process-icon">
          {processing
            ? <span className="turn-process-pulse" />
            : <Icon name="check" size={12} />}
        </span>
        <span className="turn-process-title">{processing ? '处理中' : '已处理'}</span>
        {duration && <span className="turn-process-time">{duration}</span>}
        <span className="turn-process-spacer" />
        <Icon name="down" size={13} className="process-chevron" />
      </summary>
      <div className="turn-process-body">
        {items.length === 0 && <div className="turn-process-empty">正在处理…</div>}
        {items.map(item => (
          <ItemCard key={item.id} sessionId={sessionId} item={item} inProcess />
        ))}
      </div>
    </details>
  )
}

export function TurnBlock({
  sessionId,
  meta,
  cache,
  refreshKey,
  running = false,
  agentName,
  modelLabel: fallbackModelLabel,
}: {
  sessionId: string
  meta: UiTurnMeta
  cache: TurnCache
  refreshKey: number
  running?: boolean
  /** 当前主 agent 的显示名。 */
  agentName?: string
  /** 当前 agent 的模型；本轮还没写入 turnUsage 时兜底。 */
  modelLabel?: string
}) {
  const [items, setItems] = useState<UiTimelineItem[] | undefined>(() => cache.get(meta.turn))
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    const cached = cache.get(meta.turn)
    if (cached) {
      setItems(cached)
      return
    }
    let cancelled = false
    setItems(undefined)
    void api.turnItems(sessionId, meta.turn)
      .then(next => {
        if (cancelled) return
        cache.set(meta.turn, next)
        setItems(next)
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [cache, meta.turn, refreshKey, sessionId])

  const list = items ?? []
  const userItems = list.filter(item => item.kind === 'user')
  const processItems = list.filter(isProcessItem)
  const assistantItems = list.filter(item => item.kind === 'assistant')
  const systemItems = list.filter(item => item.kind === 'system')
  const turnItems = list.filter(item => item.kind === 'turn')
  const turnModel = turnItems.find(item => item.turnUsage?.model)?.turnUsage?.model
  const modelLabel = turnModel
    ? `${turnModel.provider}/${turnModel.model}`
    : fallbackModelLabel
  const turnDuration = turnItems.find(item =>
    item.turnUsage?.durationMs !== undefined)?.turnUsage?.durationMs
  const turnStartedAt = userItems[0]?.ts ?? list[0]?.ts
  const agentTime = formatClock(
    assistantItems[0]?.ts ?? processItems[0]?.ts ?? list[0]?.ts,
  )

  return (
    <section className="turn-block" data-turn={meta.turn}>
      {error && <div className="inline-error">{error}</div>}
      {!items && !error && (
        <div className="msg-skeleton" aria-label="载入本轮">
          <span />
          <span />
        </div>
      )}

      {userItems.map(item => (
        <ItemCard key={item.id} sessionId={sessionId} item={item} />
      ))}

      {(processItems.length > 0 || assistantItems.length > 0 || running) && (
        <div className="turn-agent">
          <img className="msg-avatar" src="/icon.png" alt="" />
          <div className="turn-agent-main">
            <div className="turn-agent-head">
              <span className="turn-agent-name">{agentName ?? '助手'}</span>
              <span className="turn-agent-model" title={modelLabel}>
                {modelLabel ?? '模型'}
              </span>
              {agentTime && <span className="msg-time">{agentTime}</span>}
            </div>
            {(processItems.length > 0 || running) && (
              <TurnProcess
                sessionId={sessionId}
                items={processItems}
                running={running}
                durationMs={turnDuration}
                startedAt={turnStartedAt}
              />
            )}
            {assistantItems.map(item => (
              <ItemCard
                key={item.id}
                sessionId={sessionId}
                item={item}
                bare
                {...(modelLabel ? { modelLabel } : {})}
              />
            ))}
          </div>
        </div>
      )}

      {systemItems.map(item => (
        <ItemCard key={item.id} sessionId={sessionId} item={item} />
      ))}

      {turnItems.map(item => (
        <ItemCard key={item.id} sessionId={sessionId} item={item} />
      ))}
    </section>
  )
}
