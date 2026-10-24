import type { TurnCache } from '../cache'
import { formatBytes, formatDateTime, shortId } from '../lib/format'
import type {
  SessionInfo,
  SessionInspection,
  UiApproval,
  UiSessionStats,
  UiTurnMeta,
} from '../types'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { Timeline } from './Timeline'
import {
  Badge,
  Button,
  IconButton,
  LifecycleBadge,
  Spinner,
  StatusDot,
} from './Ui'

export function FocusWindow({
  session,
  inspection,
  stats,
  turns,
  cache,
  revision,
  approvals,
  loading,
  error,
  sending,
  onSend,
  onRefresh,
  onClose,
  onDetails,
  onArchive,
  onUnarchive,
  onDelete,
  onOpenApprovals,
}: {
  session: SessionInfo
  inspection: SessionInspection | undefined
  stats: UiSessionStats | undefined
  turns: UiTurnMeta[]
  cache: TurnCache
  revision: number
  approvals: UiApproval[]
  loading: boolean
  error: string | undefined
  sending: boolean
  onSend: (text: string) => Promise<void>
  onRefresh: () => void
  onClose: () => void
  onDetails: () => void
  onArchive: () => void
  onUnarchive: () => void
  onDelete: () => void
  onOpenApprovals: () => void
}) {
  const lifecycle = inspection?.lifecycle ?? session.lifecycle
  const state = inspection?.state ?? session.state ?? 'unknown'
  const disabled = lifecycle !== 'active'
  const disabledReason = lifecycle === 'archived'
    ? '这个会话已归档。恢复后可以继续发送。'
    : lifecycle === 'deleted'
      ? '这个会话已删除，只能查看历史。'
      : undefined

  return (
    <section className="focus-window" aria-label={`会话 ${session.id}`}>
      <header className="focus-head">
        <div className="focus-title">
          <div className="focus-line">
            <StatusDot state={state} />
            <h1 title={session.id}>{shortId(session.id, 26)}</h1>
            <LifecycleBadge lifecycle={lifecycle} />
            <span className="state-pill">{state}</span>
          </div>
          <div className="focus-sub">
            <span>{session.createdBy ?? 'user'}</span>
            <span>·</span>
            <span>{formatDateTime(session.updatedAt)}</span>
            <span>·</span>
            <span>{formatBytes(session.bytes)}</span>
            {stats && <><span>·</span><span>{stats.turns} 轮</span></>}
            {session.reason && <><span>·</span><span className="focus-reason">{session.reason}</span></>}
          </div>
        </div>

        <div className="focus-actions">
          {loading && <Spinner />}
          {lifecycle === 'active' && (
            <Button size="sm" variant="ghost" icon="archive" onClick={onArchive}><span>归档</span></Button>
          )}
          {lifecycle === 'archived' && (
            <Button size="sm" variant="ghost" icon="refresh" onClick={onUnarchive}><span>恢复</span></Button>
          )}
          {lifecycle !== 'deleted' && (
            <Button size="sm" variant="ghost" icon="trash" className="danger-text" onClick={onDelete}><span>删除</span></Button>
          )}
          <IconButton icon="panel" label="会话详情" onClick={onDetails} />
          <IconButton icon="refresh" label="刷新" onClick={onRefresh} />
          <IconButton icon="close" label="回到星图" onClick={onClose} />
        </div>
      </header>

      {error && (
        <div className="banner error">
          <Icon name="warning" size={15} />
          {error}
        </div>
      )}

      {approvals.length > 0 && (
        <button className="approval-banner" onClick={onOpenApprovals}>
          <span className="approval-pulse" />
          <span>{approvals.length} 个工具等待审批</span>
          <span className="approval-banner-tools">
            {approvals.map(item => item.toolName).join(' · ')}
          </span>
          <Icon name="chevron" size={15} />
        </button>
      )}

      {disabled && (
        <div className="banner muted-banner">
          <Icon name="archive" size={15} />
          {disabledReason}
        </div>
      )}

      <Timeline
        sessionId={session.id}
        turns={turns}
        cache={cache}
        refreshKey={revision}
      />

      <Composer
        disabled={disabled}
        {...(disabledReason ? { disabledReason } : {})}
        sending={sending}
        onSend={onSend}
      />
    </section>
  )
}
