import { useEffect, useState } from 'react'
import type { AgentSummary, SessionInfo } from '../types'
import { MemoryPanel } from './MemoryPanel'
import { StatusPanel } from './StatusPanel'

type PanelTab = 'status' | 'memory'

export function AgentPanel({
  agentId,
  agent,
  sessions,
  onSelectSession,
  onOpenSettings,
  onChanged,
  onClose,
}: {
  agentId: string | undefined
  agent: AgentSummary | undefined
  sessions: SessionInfo[]
  onSelectSession: (sessionId: string) => void
  onOpenSettings: () => void
  onChanged: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<PanelTab>('status')

  useEffect(() => {
    setTab('status')
  }, [agentId])

  return (
    <div className="fw-agent-panel">
      <div className="fw-panel-tabs">
        <button
          type="button"
          className={tab === 'status' ? 'is-active' : ''}
          onClick={() => setTab('status')}
        >
          状态
        </button>
        <button
          type="button"
          className={tab === 'memory' ? 'is-active' : ''}
          onClick={() => setTab('memory')}
        >
          记忆
        </button>
        <button
          type="button"
          className="fw-panel-close"
          onClick={onClose}
          aria-label="关闭面板"
          title="关闭面板"
        >
          ×
        </button>
      </div>
      <div className="fw-panel-content">
        {tab === 'status'
          ? (agentId
            ? (
              <StatusPanel
                agentId={agentId}
                agent={agent}
                sessions={sessions}
                onSelectSession={onSelectSession}
                onOpenSettings={onOpenSettings}
                onChanged={onChanged}
              />
            )
            : <div className="fw-panel-empty">先添加或选择一个主 agent。</div>)
          : <MemoryPanel />}
      </div>
    </div>
  )
}
