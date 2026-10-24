import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { TurnCache } from '../cache'
import type { SessionInspection, UiSessionStats, UiTurnMeta } from '../types'

export function useSession(sessionId: string | undefined) {
  const [turns, setTurns] = useState<UiTurnMeta[]>([])
  const [inspection, setInspection] = useState<SessionInspection>()
  const [stats, setStats] = useState<UiSessionStats>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const cache = useMemo(() => new TurnCache(), [sessionId])
  const requestSeq = useRef(0)
  const inFlight = useRef(false)
  const lastSignature = useRef('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId || inFlight.current) return
    inFlight.current = true
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const [nextTurns, nextInspection, nextStats] = await Promise.all([
        api.turns(sessionId),
        api.inspect(sessionId),
        api.stats(sessionId),
      ])
      if (seq !== requestSeq.current) return
      const latest = nextTurns.at(-1)
      const signature = latest ? `${latest.turn}:${latest.endSeq}:${latest.itemCount}` : ''
      if (latest && signature !== lastSignature.current) cache.delete(latest.turn)
      lastSignature.current = signature
      setTurns(nextTurns)
      setInspection(nextInspection)
      setStats(nextStats)
      setRevision(value => value + 1)
      setError(undefined)
    } catch (reason) {
      if (seq === requestSeq.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        inFlight.current = false
      }
    }
  }, [cache, sessionId])

  useEffect(() => {
    requestSeq.current += 1
    setTurns([])
    setInspection(undefined)
    setStats(undefined)
    setError(undefined)
    lastSignature.current = ''
    inFlight.current = false
    cache.clear()
    if (!sessionId) return
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [cache, refresh, sessionId])

  return {
    turns,
    inspection,
    stats,
    loading,
    error,
    cache,
    revision,
    refresh,
  }
}
