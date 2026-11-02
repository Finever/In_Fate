import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { MemoryProposal, UiApproval } from '../types'

/**
 * 审批中心的数据源：工具审批有时限，单独用更短的轮询间隔。
 * 记忆提议和工具审批在这里合流，由应用内弹窗统一处理。
 */
export function useApprovals() {
  const [approvals, setApprovals] = useState<UiApproval[]>([])
  const [proposals, setProposals] = useState<MemoryProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const requestSeq = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    const seq = ++requestSeq.current
    try {
      const [nextApprovals, nextProposals] = await Promise.all([
        api.approvals(),
        api.memoryProposals('pending'),
      ])
      if (seq !== requestSeq.current) return
      setApprovals(nextApprovals)
      setProposals(nextProposals)
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
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  return {
    approvals,
    proposals,
    loading,
    error,
    refresh,
  }
}
