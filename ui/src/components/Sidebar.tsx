import { useMemo, useRef, useState } from 'react'
import { modLabel } from '../lib/platform'
import { groupSessions, sessionDisplayTitle, sessionTime } from '../lib/sessions'
import type { SessionInfo, SessionLink } from '../types'
import { Icon } from './Icon'
import { LinkRail } from './LinkRail'
import { StatusDot } from './Ui'

const STATE_LABEL: Record<string, string> = {
  running: '运行中',
  waiting: '等待',
  idle: '空闲',
  done: '完成',
}

function SessionRow({
  session,
  selected,
  busy,
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  session: SessionInfo
  selected: boolean
  busy: boolean
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
}) {
  const title = sessionDisplayTitle(session)
  const showStateDot = session.state === 'running' || session.state === 'waiting'
  const meta = session.state && session.state !== 'unknown'
    ? STATE_LABEL[session.state] ?? session.state
    : session.lifecycle === 'archived'
      ? '归档'
      : session.lifecycle === 'deleted'
        ? '已删除'
        : ''

  return (
    <div
      className={`session-row lifecycle-${session.lifecycle}${selected ? ' selected' : ''}`}
      data-session-id={session.id}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(session.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(session.id)
        }
      }}
    >
      {showStateDot && <span className="session-state"><StatusDot state={session.state} /></span>}
      <span className="session-main">
        <span className="session-title" title={title}>{title}</span>
        <span className="session-meta">
          {meta && <span className={`session-state-label state-${session.state ?? 'unknown'}`}>{meta}</span>}
          {meta && <span className="session-sep">·</span>}
          <span>{sessionTime(session.updatedAt)}</span>
        </span>
      </span>
      <span className="session-actions" onClick={event => event.stopPropagation()}>
        {session.lifecycle === 'active' && (
          <button
            type="button"
            className="row-action"
            title="归档"
            aria-label="归档"
            disabled={busy}
            onClick={() => onArchive(session.id)}
          >
            <Icon name="archive" size={14} />
          </button>
        )}
        {session.lifecycle === 'archived' && (
          <button
            type="button"
            className="row-action"
            title="恢复"
            aria-label="恢复"
            disabled={busy}
            onClick={() => onUnarchive(session.id)}
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
        {session.lifecycle !== 'deleted' && (
          <button
            type="button"
            className="row-action danger"
            title="删除"
            aria-label="删除"
            disabled={busy}
            onClick={() => onDelete(session.id)}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </span>
    </div>
  )
}

export function Sidebar({
  sessions,
  links,
  selectedId,
  approvals,
  agentsRunning,
  online,
  refreshing,
  showArchived,
  showDeleted,
  query,
  busy,
  onQuery,
  onSelect,
  onCreate,
  onRefresh,
  onToggleArchived,
  onToggleDeleted,
  onArchive,
  onUnarchive,
  onDelete,
  onApprovals,
  onAgents,
  onCommand,
}: {
  sessions: SessionInfo[]
  links: SessionLink[]
  selectedId: string | undefined
  approvals: number
  agentsRunning: number
  online: boolean
  refreshing: boolean
  showArchived: boolean
  showDeleted: boolean
  query: string
  busy: boolean
  onQuery: (value: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onRefresh: () => void
  onToggleArchived: () => void
  onToggleDeleted: () => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onApprovals: () => void
  onAgents: () => void
  onCommand: () => void
}) {
  const [filterOpen, setFilterOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupSessions(sessions, query), [query, sessions])
  const activeCount = sessions.filter(session => session.lifecycle === 'active').length
  const revision = `${query}|${showArchived}|${showDeleted}|${groups.map(group => `${group.key}:${group.sessions.length}`).join(',')}`

  return (
    <aside className="sidebar" aria-label="会话列表">
      <header className="side-head">
        <span className="side-brand-mark">IF</span>
        <span className="side-brand-copy">
          <b>In_Fate</b>
          <small>workspace</small>
        </span>
      </header>

      <div className="side-new-wrap">
        <button className="new-session" onClick={onCreate} disabled={busy}>
          <Icon name="plus" size={16} />
          <span>新建会话</span>
          <kbd>{modLabel} N</kbd>
        </button>
      </div>

      <div className="side-search">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={event => onQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') onQuery('')
          }}
          placeholder="搜索会话"
          aria-label="搜索会话"
        />
        {query
          ? <button type="button" className="search-clear" onClick={() => onQuery('')} aria-label="清空搜索"><Icon name="close" size={13} /></button>
          : <kbd>{modLabel} K</kbd>}
      </div>

      <div className="side-section">
        <span className="side-section-title">会话</span>
        <span className="side-count">{activeCount}</span>
        <span className="side-section-spacer" />
        <button
          type="button"
          className={`icon-btn${refreshing ? ' spinning' : ''}`}
          onClick={onRefresh}
          aria-label="刷新"
          title="刷新"
        >
          <Icon name="refresh" size={15} />
        </button>
        <div className="filter-wrap">
          <button
            type="button"
            className={`icon-btn${showArchived || showDeleted ? ' active' : ''}`}
            onClick={() => setFilterOpen(value => !value)}
            aria-label="筛选"
            title="筛选"
          >
            <Icon name="filter" size={15} />
          </button>
          {filterOpen && (
            <>
              <button
                type="button"
                className="popover-backdrop"
                aria-label="关闭筛选"
                onClick={() => setFilterOpen(false)}
              />
              <div className="filter-pop" role="menu">
                <label>
                  <input type="checkbox" checked={showArchived} onChange={onToggleArchived} />
                  <span>显示归档</span>
                </label>
                <label>
                  <input type="checkbox" checked={showDeleted} onChange={onToggleDeleted} />
                  <span>显示已删除</span>
                </label>
                <p>删除是软删除，事件文件保留。</p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="side-scroll">
        <div className="side-content" ref={contentRef}>
          {groups.length === 0 && (
            <div className="side-empty">
              <Icon name="chat" size={22} />
              <strong>{query ? '没有匹配的会话' : '还没有会话'}</strong>
              <span>{query ? '换个关键词试试。' : '新建一个，开始第一句话。'}</span>
              {query && (
                <button type="button" className="text-link" onClick={() => onQuery('')}>清空搜索</button>
              )}
            </div>
          )}
          {groups.map(group => (
            <section className="session-group" key={group.key}>
              <div className="session-group-label">
                <span>{group.label}</span>
                <span>{group.sessions.length}</span>
              </div>
              {group.sessions.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={session.id === selectedId}
                  busy={busy}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                  onDelete={onDelete}
                />
              ))}
            </section>
          ))}
          <LinkRail
            contentRef={contentRef}
            selectedId={selectedId}
            links={links}
            sessions={sessions}
            revision={revision}
          />
        </div>
      </div>

      <footer className="side-foot">
        <button type="button" className="side-foot-btn" onClick={onApprovals}>
          <Icon name="approvals" size={15} />
          <span>审批</span>
          {approvals > 0 && <b>{approvals}</b>}
        </button>
        <button type="button" className="side-foot-btn" onClick={onAgents}>
          <Icon name="agents" size={15} />
          <span>agent</span>
          {agentsRunning > 0 && <b>{agentsRunning}</b>}
        </button>
        <button type="button" className="side-foot-btn" onClick={onCommand}>
          <Icon name="search" size={15} />
          <span>命令</span>
        </button>
        <span className={`online-text${online ? ' on' : ''}`} title={online ? '已连接' : '离线'}>
          {online ? '在线' : '离线'}
        </span>
      </footer>
    </aside>
  )
}
