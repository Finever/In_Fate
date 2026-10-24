import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TurnCache } from '../cache'
import type { UiTimelineItem, UiTurnMeta } from '../types'
import { ItemCard } from './ItemCard'

export function TurnBlock({
  sessionId,
  meta,
  cache,
  refreshKey,
}: {
  sessionId: string
  meta: UiTurnMeta
  cache: TurnCache
  refreshKey: number
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

  return (
    <section className="turn-block" data-turn={meta.turn}>
      {error && <div className="inline-error">{error}</div>}
      {!items && !error && (
        <div className="msg-skeleton" aria-label="载入本轮">
          <span />
          <span />
        </div>
      )}
      {items?.map(item => (
        <ItemCard key={item.id} sessionId={sessionId} item={item} />
      ))}
    </section>
  )
}
