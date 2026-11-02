import { useMemo } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { SessionInfo } from '../types'
import { groupSessions, sessionDisplayTitle, sessionTime } from '../lib/sessions'
import { Icon } from './Icon'

function FrameResizer({
  side,
  onPointerDown,
}: {
  side: 'left' | 'right'
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={`fw-resizer fw-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整左栏宽度' : '调整右栏宽度'}
      title="拖动调整宽度"
      onPointerDown={onPointerDown}
    />
  )
}

export interface MainAgentListItem {
  id: string
  name: string
  sessionCount: number
}

function AgentRow({
  item,
  selected,
  onSelect,
}: {
  item: MainAgentListItem
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={`fw-agent${selected ? ' is-selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(item.id)}
      title={item.id}
    >
      <span className="fw-agent-name"><span>{item.name}</span></span>
      <span className="fw-agent-count">{item.sessionCount}</span>
    </button>
  )
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionInfo
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={`fw-session${selected ? ' is-selected' : ''}`}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(session.id)}
      title={session.id}
    >
      <span className="fw-session-title">{sessionDisplayTitle(session)}</span>
      <span className="fw-session-time">{sessionTime(session.updatedAt)}</span>
    </button>
  )
}

export function FrameSidebar({
  sessions,
  totalSessions,
  agents,
  selectedAgentId,
  selectedId,
  onSelect,
  onSelectAgent,
  onAddAgent,
  onResizeStart,
}: {
  sessions: SessionInfo[]
  totalSessions: number
  agents: MainAgentListItem[]
  selectedAgentId: string
  selectedId: string | undefined
  onSelect: (id: string) => void
  onSelectAgent: (id: string) => void
  onAddAgent: () => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const groups = useMemo(() => groupSessions(sessions, ''), [sessions])

  return (
    <aside className="fw-left" aria-label="agent 与会话列表">
      <div className="fw-left-body">
        <nav className="fw-agent-rail" aria-label="agent 列表">
          <div className="fw-agent-head">
            <span>agent</span>
            <button
              type="button"
              className="fw-agent-add"
              onClick={onAddAgent}
              aria-label="添加 agent"
              title="添加 agent"
            >
              <Icon name="plus" size={13} />
            </button>
          </div>
          <button
            type="button"
            className={`fw-agent fw-agent-all${selectedAgentId === 'all' ? ' is-selected' : ''}`}
            onClick={() => onSelectAgent('all')}
          >
            <span className="fw-agent-name"><span>全部</span></span>
            <span className="fw-agent-count">{totalSessions}</span>
          </button>
          {agents.map(item => (
            <AgentRow
              key={item.id}
              item={item}
              selected={item.id === selectedAgentId}
              onSelect={onSelectAgent}
            />
          ))}
          {agents.length === 0 && <span className="fw-agent-empty">暂无</span>}
        </nav>

        <div className="fw-session-pane">
          <div className="fw-list">
            {groups.length === 0 && (
              <div className="fw-empty-list">还没有会话</div>
            )}
            {groups.map(group => (
              <section className="fw-group" key={group.key}>
                <div className="fw-group-label">{group.label}</div>
                {group.sessions.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>

      <FrameResizer side="left" onPointerDown={onResizeStart} />
    </aside>
  )
}

export function FrameCenter({
  session,
  rightOpen,
  error,
  onToggleRight,
  onCreate,
  children,
}: {
  session: SessionInfo | undefined
  rightOpen: boolean
  error: string | undefined
  onToggleRight: () => void
  onCreate: () => void
  children?: ReactNode
}) {
  return (
    <main className="fw-center" aria-label="主工作区">
      <header className="fw-center-head">
        <h1>{session ? sessionDisplayTitle(session) : 'In_Fate'}</h1>
        <button
          type="button"
          className={`fw-panel-btn${rightOpen ? ' is-active' : ''}`}
          onClick={onToggleRight}
        >
          <Icon name="panel" size={14} />
          {rightOpen ? '收起面板' : '打开面板'}
        </button>
      </header>

      {error && <div className="fw-error">{error}</div>}

      <div className={`fw-center-body${children ? ' has-session' : ''}`}>
        {children ?? (
          session
            ? <span className="fw-placeholder">会话内容区</span>
            : (
              <div className="fw-welcome">
                <span>选一个会话，或者新建一个。</span>
                <button type="button" className="fw-new" onClick={onCreate}>
                  <Icon name="plus" size={15} />
                  新建会话
                </button>
              </div>
            )
        )}
      </div>
    </main>
  )
}

export function FrameRight({
  open,
  onResizeStart,
  children,
}: {
  open: boolean
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  children?: ReactNode
}) {
  if (!open) return null
  return (
    <aside className="fw-right" aria-label="面板">
      <div className={`fw-right-body${children ? ' has-content' : ''}`}>
        {children ?? <span className="fw-placeholder">面板内容区</span>}
      </div>
      <FrameResizer side="right" onPointerDown={onResizeStart} />
    </aside>
  )
}

export function FrameGate({ onReady }: { onReady: (token: string) => void }) {
  return (
    <div className="fw-gate">
      <div className="fw-gate-card">
        <img className="fw-logo" src="/icon.png" alt="" />
        <h1>In_Fate</h1>
        <p>输入 `if serve` 打印的 token。</p>
        <input
          autoFocus
          id="fw-token"
          placeholder="token"
          onKeyDown={event => {
            if (event.key !== 'Enter') return
            const value = (event.target as HTMLInputElement).value.trim()
            if (value) onReady(value)
          }}
        />
        <button
          type="button"
          className="fw-new"
          onClick={() => {
            const input = document.getElementById('fw-token') as HTMLInputElement | null
            const value = input?.value.trim()
            if (value) onReady(value)
          }}
        >
          进入
        </button>
      </div>
    </div>
  )
}

export function FrameBoot() {
  return (
    <div className="fw-boot">
      <img className="fw-logo" src="/icon.png" alt="" />
      <span>载入工作区…</span>
    </div>
  )
}
