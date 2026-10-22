import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TurnCache } from '../cache'
import type { UiTimelineItem, UiTurnMeta } from '../types'
import { ItemCard } from './ItemCard'

interface Props {
  sessionId: string
  meta: UiTurnMeta
  cache: TurnCache
  refreshKey: number
}

export function TurnBlock({ sessionId, meta, cache, refreshKey }: Props) {
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

  const title = items?.find(item => item.kind === 'user')?.content?.preview
    ?? items?.find(item => item.kind === 'system')?.content?.preview
    ?? `第 ${meta.turn} 轮`

  return (
    <section className="turn" data-turn={meta.turn}>
      <header className="turn-head">
        <span className="turn-no">#{meta.turn}</span>
        <span className="turn-title">{title}</span>
        <span className="turn-meta">{meta.itemCount} 条</span>
      </header>
      {error && <div className="error">{error}</div>}
      {!items && !error && <div className="skeleton">载入本轮…</div>}
      {items?.map(item => (
        <ItemCard key={item.id} sessionId={sessionId} item={item} />
      ))}
    </section>
  )
}
