import { useMemo, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { SessionInfo } from '../types'
import { groupSessionsSmart, sessionDisplayTitle, sessionTime } from '../lib/sessions'
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
  busy,
  agentLabel,
  showAgent,
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  session: SessionInfo
  selected: boolean
  busy: boolean
  agentLabel: string
  showAgent: boolean
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
}) {
  const state = session.state === 'running' || session.state === 'waiting'
    ? session.state
    : undefined
  return (
    <div className={`fw-session-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="fw-session"
        aria-current={selected ? 'page' : undefined}
        onClick={() => onSelect(session.id)}
        title={session.id}
      >
        {state && <span className={`fw-session-state is-${state}`} title={state === 'running' ? '运行中' : '等待'} />}
        <span className="fw-session-main">
          <span className="fw-session-title">{sessionDisplayTitle(session)}</span>
          {showAgent && <span className="fw-session-agent">{agentLabel}</span>}
        </span>
        <span className="fw-session-time">{sessionTime(session.updatedAt)}</span>
      </button>
      <span className="fw-session-actions">
        {session.lifecycle === 'active' && (
          <button
            type="button"
            className="fw-row-action"
            title="归档"
            aria-label="归档"
            disabled={busy}
            onClick={() => onArchive(session.id)}
          >
            <Icon name="archive" size={12} />
          </button>
        )}
        {session.lifecycle === 'archived' && (
          <button
            type="button"
            className="fw-row-action"
            title="恢复"
            aria-label="恢复"
            disabled={busy}
            onClick={() => onUnarchive(session.id)}
          >
            <Icon name="refresh" size={12} />
          </button>
        )}
        {session.lifecycle !== 'deleted' && (
          <button
            type="button"
            className="fw-row-action is-danger"
            title="删除"
            aria-label="删除"
            disabled={busy}
            onClick={() => onDelete(session.id)}
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </span>
    </div>
  )
}

export function FrameSidebar({
  sessions,
  totalSessions,
  agents,
  selectedAgentId,
  selectedId,
  busy,
  showDeleted,
  onSelect,
  onSelectAgent,
  onCreate,
  onAddAgent,
  onArchive,
  onUnarchive,
  onDelete,
  onToggleDeleted,
  onResizeStart,
}: {
  sessions: SessionInfo[]
  totalSessions: number
  agents: MainAgentListItem[]
  selectedAgentId: string
  selectedId: string | undefined
  busy: boolean
  showDeleted: boolean
  onSelect: (id: string) => void
  onSelectAgent: (id: string) => void
  onCreate: () => void
  onAddAgent: () => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onToggleDeleted: () => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupSessionsSmart(sessions, query), [query, sessions])
  const agentNames = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent.name])),
    [agents],
  )
  const showAgent = selectedAgentId === 'all'

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
          <div className="fw-session-head">
            <span>会话</span>
            <div className="fw-session-head-actions">
              <button
                type="button"
                className={`fw-session-filter${showDeleted ? ' is-active' : ''}`}
                onClick={onToggleDeleted}
                title={showDeleted ? '隐藏已删除会话' : '显示已删除会话'}
              >
                已删除
              </button>
              <button
                type="button"
                className="fw-session-add"
                onClick={onCreate}
                disabled={busy}
                title="新建会话"
              >
                <Icon name="plus" size={12} />
                新建
              </button>
            </div>
          </div>
          <div className="fw-session-search">
            <Icon name="search" size={12} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索会话"
              aria-label="搜索会话"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
                ×
              </button>
            )}
          </div>
          <div className="fw-list">
            {groups.length === 0 && (
              <div className="fw-empty-list">{query ? '没有匹配的会话' : '还没有会话'}</div>
            )}
            {groups.map(group => (
              <section className="fw-group" key={group.key}>
                <div className="fw-group-label">{group.label}</div>
                {group.sessions.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedId}
                    busy={busy}
                    agentLabel={agentNames.get(session.agentId ?? agents[0]?.id ?? 'main')
                      ?? session.agentId
                      ?? '默认'}
                    showAgent={showAgent}
                    onSelect={onSelect}
                    onArchive={onArchive}
                    onUnarchive={onUnarchive}
                    onDelete={onDelete}
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
  busy,
  onToggleRight,
  onCreate,
  onCategory,
  onThinking,
  onTogglePin,
  thinkingSupported,
  onArchive,
  onUnarchive,
  onDelete,
  children,
}: {
  session: SessionInfo | undefined
  rightOpen: boolean
  error: string | undefined
  busy: boolean
  onToggleRight: () => void
  onCreate: () => void
  onCategory: () => void
  onThinking: () => void
  onTogglePin: (id: string, pinned: boolean) => void
  thinkingSupported: boolean
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  children?: ReactNode
}) {
  return (
    <main className="fw-center" aria-label="主工作区">
      <header className="fw-center-head">
        <h1>{session ? sessionDisplayTitle(session) : 'In_Fate'}</h1>
        {session && session.lifecycle === 'active' && (
          <button
            type="button"
            className="fw-head-action"
            onClick={onCategory}
            disabled={busy}
          >
            <Icon name="layers" size={13} />
            {session.category ? '改分类' : '分类'}
          </button>
        )}
        {session && session.lifecycle === 'active' && (
          <button
            type="button"
            className={`fw-head-action${session.thinkingHeadEnabled ? ' is-active' : ''}`}
            onClick={onThinking}
            disabled={busy || (!thinkingSupported && !session.thinkingHeadEnabled && !session.thinkingHead)}
            title={thinkingSupported ? '会话思考头' : '当前模型接口不支持 assistant prefill'}
          >
            <Icon name="chat" size={13} />
            思考头
          </button>
        )}
        {session && session.lifecycle === 'active' && (
          <button
            type="button"
            className={`fw-head-action${session.pinned ? ' is-active' : ''}`}
            onClick={() => onTogglePin(session.id, !session.pinned)}
            disabled={busy}
          >
            <Icon name="pin" size={13} />
            {session.pinned ? '取消置顶' : '置顶'}
          </button>
        )}
        {session && session.lifecycle === 'active' && (
          <button
            type="button"
            className="fw-head-action"
            onClick={() => onArchive(session.id)}
            disabled={busy}
          >
            <Icon name="archive" size={13} />
            归档
          </button>
        )}
        {session && session.lifecycle === 'archived' && (
          <button
            type="button"
            className="fw-head-action"
            onClick={() => onUnarchive(session.id)}
            disabled={busy}
          >
            <Icon name="refresh" size={13} />
            恢复
          </button>
        )}
        {session && session.lifecycle === 'active' && (
          <button
            type="button"
            className="fw-head-action is-danger"
            onClick={() => onDelete(session.id)}
            disabled={busy}
          >
            <Icon name="trash" size={13} />
            删除
          </button>
        )}
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
