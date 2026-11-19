import { useState } from 'react'
import type { AgentSummary, SessionInfo } from '../types'
import { PersonaPanel } from './PersonaPanel'
import { StatusPanel } from './StatusPanel'

type PanelTab = 'status' | 'persona'

export function AgentPanel({
  agentId,
  agent,
  sessions,
  onSelectSession,
  onOpenSettings,
  onChanged,
  onDeleted,
  onClose,
}: {
  agentId: string | undefined
  agent: AgentSummary | undefined
  sessions: SessionInfo[]
  onSelectSession: (sessionId: string) => void
  onOpenSettings: () => void
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<PanelTab>('status')

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
          className={tab === 'persona' ? 'is-active' : ''}
          onClick={() => setTab('persona')}
        >
          人格文件
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
                onDeleted={onDeleted}
              />
            )
            : <div className="fw-panel-empty">先添加或选择一个主 agent。</div>)
          : (agentId
            ? <PersonaPanel agentId={agentId} />
            : <div className="fw-panel-empty">先添加或选择一个主 agent。</div>)}
      </div>
    </div>
  )
}
