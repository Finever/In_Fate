import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AgentRunInfo, SessionInfo, SessionLink, UiApproval } from '../types'

export interface WorkspaceData {
  sessions: SessionInfo[]
  links: SessionLink[]
  agents: AgentRunInfo[]
  approvals: UiApproval[]
}

const EMPTY: WorkspaceData = {
  sessions: [],
  links: [],
  agents: [],
  approvals: [],
}

export function useWorkspace() {
  const [data, setData] = useState<WorkspaceData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)

  const refresh = useCallback(async (manual = false): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    if (manual) setRefreshing(true)
    try {
      const [sessions, links, agents, approvals] = await Promise.all([
        api.sessions({ includeArchived: true, includeDeleted: true }),
        api.links(),
        api.agents({ includeArchived: true, includeDeleted: true }),
        api.approvals(),
      ])
      setData({ sessions, links, agents, approvals })
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      setLoading(false)
      if (manual) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(false)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  return {
    ...data,
    loading,
    refreshing,
    error,
    refresh,
    setError,
  }
}
