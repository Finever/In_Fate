import { formatBytes, relativeTime, shortId } from '../lib/format'
import { modLabel } from '../lib/platform'
import type { SessionInfo } from '../types'
import { Icon } from './Icon'
import { Button, IconButton, LifecycleBadge, StatusDot } from './Ui'

export function TopBar({
  sessions,
  selected,
  online,
  refreshing,
  showArchived,
  showDeleted,
  onToggleArchived,
  onToggleDeleted,
  onCommand,
  onRefresh,
  onFullscreen,
  onOverview,
}: {
  sessions: SessionInfo[]
  selected: SessionInfo | undefined
  online: boolean
  refreshing: boolean
  showArchived: boolean
  showDeleted: boolean
  onToggleArchived: () => void
  onToggleDeleted: () => void
  onCommand: () => void
  onRefresh: () => void
  onFullscreen: () => void
  onOverview: () => void
}) {
  const active = sessions.filter(session => session.lifecycle === 'active').length

  return (
    <header className="topbar">
      <button className="topbar-brand" onClick={onOverview} title="回到星图">
        <span className="brand-mark">IF</span>
        <span className="brand-text">
          <b>In_Fate</b>
          <small>workspace</small>
        </span>
      </button>

      <div className="topbar-center">
        {selected ? (
          <button className="crumb" onClick={onOverview} title="回到星图">
            <StatusDot state={selected.state} />
            <span>{shortId(selected.id, 20)}</span>
            <LifecycleBadge lifecycle={selected.lifecycle} />
          </button>
        ) : (
          <span className="topbar-hint">
            {active} 个活跃会话 · 点星图节点，或按 ⌘K
          </span>
        )}
      </div>

      <div className="topbar-actions">
        <div className="filter-pills">
          <button
            className={`filter-pill${showArchived ? ' on' : ''}`}
            onClick={onToggleArchived}
            title="显示/隐藏归档"
          >
            归档
          </button>
          <button
            className={`filter-pill${showDeleted ? ' on danger' : ''}`}
            onClick={onToggleDeleted}
            title="显示/隐藏已删除"
          >
            删除
          </button>
        </div>
        <button
          className="command-trigger"
          aria-label={`搜索 / 命令（${modLabel}+K）`}
          title={`搜索 / 命令（${modLabel}+K）`}
          onClick={onCommand}
        >
          <Icon name="search" size={15} />
          <span>搜索 / 命令</span>
          <kbd>{modLabel} K</kbd>
        </button>
        <span className={`online-pill${online ? ' on' : ''}`}>
          <span className="online-dot" />
          {online ? 'online' : 'offline'}
        </span>
        <IconButton
          icon="refresh"
          label="刷新"
          className={refreshing ? 'spinning' : ''}
          onClick={onRefresh}
        />
        <IconButton icon="fullscreen" label="全屏" onClick={onFullscreen} />
      </div>
    </header>
  )
}

export function selectedMeta(session: SessionInfo | undefined): string {
  if (!session) return ''
  return `${session.createdBy ?? 'user'} · ${formatBytes(session.bytes)} · ${relativeTime(session.updatedAt)}`
}
