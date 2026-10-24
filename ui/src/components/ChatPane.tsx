import type { TurnCache } from '../cache'
import { modLabel } from '../lib/platform'
import type {
  SessionInfo,
  SessionInspection,
  UiApproval,
  UiTurnMeta,
} from '../types'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { Timeline } from './Timeline'
import { Button, IconButton, LifecycleBadge, StatusDot } from './Ui'

function StateBadge({ state }: { state: string | undefined }) {
  if (!state || state === 'idle' || state === 'unknown') return null
  return (
    <span className={`chat-state state-${state}`}>
      <StatusDot state={state as 'running' | 'waiting' | 'done'} />
      {state === 'running' ? '运行中' : state === 'waiting' ? '等待' : state === 'done' ? '完成' : state}
    </span>
  )
}

export function ChatPane({
  session,
  title,
  inspection,
  turns,
  cache,
  revision,
  approvals,
  loading,
  error,
  sending,
  onCreate,
  onSend,
  onToggleSidebar,
  onRefresh,
  onDetails,
  onArchive,
  onUnarchive,
  onDelete,
  onOpenApprovals,
}: {
  session: SessionInfo | undefined
  title: string
  inspection: SessionInspection | undefined
  turns: UiTurnMeta[]
  cache: TurnCache
  revision: number
  approvals: UiApproval[]
  loading: boolean
  error: string | undefined
  sending: boolean
  onCreate: () => void
  onSend: (text: string) => Promise<void>
  onToggleSidebar: () => void
  onRefresh: () => void
  onDetails: () => void
  onArchive: () => void
  onUnarchive: () => void
  onDelete: () => void
  onOpenApprovals: () => void
}) {
  const lifecycle = inspection?.lifecycle ?? session?.lifecycle ?? 'active'
  const state = inspection?.state ?? session?.state
  const disabled = Boolean(session) && lifecycle !== 'active'
  const disabledReason = lifecycle === 'archived'
    ? '这个会话已归档。恢复后可以继续发送。'
    : lifecycle === 'deleted'
      ? '这个会话已删除，只能查看历史。'
      : undefined

  return (
    <section className="chat-pane" aria-label={session ? `会话 ${session.id}` : 'In_Fate'}>
      <header className="chat-head">
        <div className="chat-head-left">
          <IconButton icon="sidebar" label="会话列表" onClick={onToggleSidebar} className="chat-sidebar-toggle" />
          <span className="chat-head-brand">IF</span>
          <h1 title={session?.id ?? title}>{title}</h1>
          <StateBadge state={state} />
          {session && lifecycle !== 'active' && <LifecycleBadge lifecycle={lifecycle} />}
        </div>

        {session && (
          <div className="chat-head-actions">
            {loading && <span className="chat-loading" aria-label="载入中"><span className="spinner" /></span>}
            {approvals.length > 0 && (
              <button type="button" className="approval-chip" onClick={onOpenApprovals}>
                <Icon name="approvals" size={14} />
                {approvals.length}
              </button>
            )}
            <IconButton icon="refresh" label="刷新" onClick={onRefresh} />
            <IconButton icon="panel" label="会话详情" onClick={onDetails} />
            {lifecycle === 'active' && (
              <button type="button" className="head-text-btn" onClick={onArchive}>
                <Icon name="archive" size={14} />
                <span>归档</span>
              </button>
            )}
            {lifecycle === 'archived' && (
              <button type="button" className="head-text-btn" onClick={onUnarchive}>
                <Icon name="refresh" size={14} />
                <span>恢复</span>
              </button>
            )}
            {lifecycle !== 'deleted' && (
              <button type="button" className="head-text-btn danger" onClick={onDelete}>
                <Icon name="trash" size={14} />
                <span>删除</span>
              </button>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="chat-banner error">
          <Icon name="warning" size={15} />
          {error}
        </div>
      )}

      {approvals.length > 0 && (
        <button type="button" className="chat-banner approval" onClick={onOpenApprovals}>
          <span className="approval-pulse" />
          <span>{approvals.length} 个工具等待审批</span>
          <span className="chat-banner-tools">{approvals.map(item => item.toolName).join(' · ')}</span>
          <Icon name="chevron" size={14} />
        </button>
      )}

      {disabled && (
        <div className="chat-banner muted">
          <Icon name="archive" size={15} />
          {disabledReason}
        </div>
      )}

      <div className="chat-body">
        {!session && (
          <div className="welcome">
            <span className="welcome-mark">IF</span>
            <h1>In_Fate</h1>
            <p>选一个会话，或者从新的开始。</p>
            <Button variant="primary" icon="plus" onClick={onCreate}>新建会话</Button>
            <span className="welcome-hint">{modLabel} N 新建 · {modLabel} K 搜索</span>
          </div>
        )}

        {session && turns.length === 0 && loading && (
          <div className="chat-empty">
            <span className="spinner" aria-label="载入会话" />
          </div>
        )}

        {session && turns.length === 0 && !loading && (
          <div className="chat-empty">
            <span className="chat-empty-mark">✦</span>
            <h2>这个会话还没有消息</h2>
            <p>在下面说第一句话。每一轮都会落成事件，不会丢。</p>
          </div>
        )}

        {session && turns.length > 0 && (
          <Timeline
            sessionId={session.id}
            turns={turns}
            cache={cache}
            refreshKey={revision}
          />
        )}
      </div>

      {session && (
        <Composer
          disabled={disabled}
          {...(disabledReason ? { disabledReason } : {})}
          sending={sending}
          onSend={onSend}
        />
      )}

    </section>
  )
}
