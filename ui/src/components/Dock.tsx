import { useEffect, useRef } from 'react'
import { shortId } from '../lib/format'
import type { SessionInfo } from '../types'
import { Icon } from './Icon'
import { Badge } from './Ui'

export function Dock({
  sessions,
  selectedId,
  approvals,
  agentsRunning,
  onSelect,
  onCreate,
  onOverview,
  onApprovals,
  onAgents,
  onCommand,
}: {
  sessions: SessionInfo[]
  selectedId?: string
  approvals: number
  agentsRunning: number
  onSelect: (id: string) => void
  onCreate: () => void
  onOverview: () => void
  onApprovals: () => void
  onAgents: () => void
  onCommand: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sorted = [...sessions].sort((a, b) => {
    if (a.id === selectedId) return -1
    if (b.id === selectedId) return 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  const visible = sorted.slice(0, 4)
  const hidden = Math.max(0, sorted.length - visible.length)

  useEffect(() => {
    // 选中的会话被排到最前；重置横向滚动，避免第一个 chip 被藏在左边。
    scrollRef.current?.scrollTo({ left: 0 })
  }, [selectedId])

  return (
    <div className="dock">
      <button className="dock-brand" onClick={onOverview} title="星图">
        <span>IF</span>
      </button>

      <button className="dock-new" onClick={onCreate} title="新建会话">
        <Icon name="plus" size={17} />
      </button>

      <div className="dock-divider" />

      <div ref={scrollRef} className="dock-sessions">
        {visible.map(session => (
          <button
            key={session.id}
            className={`dock-chip${session.id === selectedId ? ' active' : ''} lifecycle-${session.lifecycle}`}
            onClick={() => onSelect(session.id)}
            title={session.reason ?? session.id}
          >
            <span className={`status-dot ${session.state ?? 'unknown'}`} />
            <span>{shortId(session.id, 14)}</span>
            {session.lifecycle !== 'active' && (
              <span className="dock-chip-state">
                {session.lifecycle === 'archived' ? '归档' : '删除'}
              </span>
            )}
          </button>
        ))}
        {hidden > 0 && (
          <button className="dock-chip dock-more" onClick={onCommand} title="查看更多会话">
            +{hidden}
          </button>
        )}
      </div>

      <div className="dock-divider" />

      <button className="dock-action" onClick={onApprovals} title="待审批" aria-label="待审批">
        <Icon name="approvals" size={17} />
        {approvals > 0 && <span className="dock-count warn">{approvals > 99 ? '99+' : approvals}</span>}
      </button>

      <button className="dock-action" onClick={onAgents} title="子 agent" aria-label="子 agent">
        <Icon name="agents" size={17} />
        {agentsRunning > 0 && <span className="dock-count mint">{agentsRunning}</span>}
      </button>

      <button className="dock-action dock-overview" onClick={onOverview} title="显示星图" aria-label="显示星图">
        <Icon name="graph" size={17} />
        <span>星图</span>
      </button>

      {approvals > 0 && (
        <Badge tone="warn" className="dock-badge">待处理</Badge>
      )}
    </div>
  )
}
