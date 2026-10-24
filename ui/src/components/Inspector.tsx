import {
  formatBytes,
  formatDateTime,
  relativeTime,
  shortId,
} from '../lib/format'
import { sessionDisplayTitle } from '../lib/sessions'
import type {
  SessionInfo,
  SessionInspection,
  SessionLink,
  UiSessionStats,
} from '../types'
import { Icon } from './Icon'
import {
  Badge,
  Button,
  IconButton,
  LifecycleBadge,
  SectionTitle,
} from './Ui'

function Row({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div className="meta-row">
      <span>{label}</span>
      <b>{value === undefined || value === '' ? '—' : value}</b>
    </div>
  )
}

export function Inspector({
  session,
  inspection,
  stats,
  links,
  sessions,
  busy,
  onArchive,
  onUnarchive,
  onDelete,
  onCloseLink,
}: {
  session: SessionInfo
  inspection: SessionInspection | undefined
  stats: UiSessionStats | undefined
  links: SessionLink[]
  sessions: SessionInfo[]
  busy: boolean
  onArchive: () => void
  onUnarchive: () => void
  onDelete: () => void
  onCloseLink: (linkId: string) => void
}) {
  const related = links.filter(link => link.from === session.id || link.to === session.id)
  const sessionById = new Map(sessions.map(item => [item.id, item]))
  const joins = inspection?.joins ?? []
  const lifecycle = inspection?.lifecycle ?? session.lifecycle

  return (
    <div className="inspector">
      <div className="inspector-status">
        <LifecycleBadge lifecycle={lifecycle} />
        <span className="state-pill">{inspection?.state ?? session.state ?? 'unknown'}</span>
        {inspection?.kind && <Badge tone="neutral">{inspection.kind}</Badge>}
      </div>

      <div className="inspector-actions">
        {lifecycle === 'active' && (
          <Button size="sm" icon="archive" onClick={onArchive} disabled={busy}>归档</Button>
        )}
        {lifecycle === 'archived' && (
          <Button size="sm" icon="refresh" onClick={onUnarchive} disabled={busy}>恢复</Button>
        )}
        {lifecycle !== 'deleted' && (
          <Button size="sm" variant="danger" icon="trash" onClick={onDelete} disabled={busy}>删除</Button>
        )}
      </div>

      <section className="inspector-section">
        <SectionTitle>会话</SectionTitle>
        <Row label="ID" value={session.id} />
        <Row label="创建者" value={session.createdBy ?? 'user'} />
        <Row label="来源" value={session.createdFrom?.sessionId ?? '—'} />
        <Row label="原因" value={session.reason} />
        <Row label="更新时间" value={`${formatDateTime(session.updatedAt)} · ${relativeTime(session.updatedAt)}`} />
        <Row label="文件" value={formatBytes(session.bytes)} />
      </section>

      {stats && (
        <section className="inspector-section">
          <SectionTitle>统计</SectionTitle>
          <div className="stat-grid">
            <div><b>{stats.events}</b><span>事件</span></div>
            <div><b>{stats.turns}</b><span>轮</span></div>
            <div><b>{stats.compacted}</b><span>压缩</span></div>
            <div><b>{stats.segments}</b><span>段</span></div>
          </div>
          <Row label="最后 seq" value={stats.lastSeq} />
          <Row label="文件大小" value={formatBytes(stats.fileBytes)} />
        </section>
      )}

      {inspection && inspection.pendingToolCalls.length > 0 && (
        <section className="inspector-section">
          <SectionTitle>等待中的工具</SectionTitle>
          {inspection.pendingToolCalls.map(call => (
            <div key={call.callId} className="mini-row">
              <Icon name="clock" size={14} />
              <span>{call.name}</span>
              <small>{shortId(call.callId, 10)}</small>
            </div>
          ))}
        </section>
      )}

      <section className="inspector-section">
        <SectionTitle right={<Badge tone="muted">{related.filter(link => link.status === 'active').length}</Badge>}>
          连接
        </SectionTitle>
        {related.length === 0 && <div className="muted-line">没有连接</div>}
        {related.map(link => {
          const other = link.from === session.id ? link.to : link.from
          const otherSession = sessionById.get(other)
          return (
            <div key={link.linkId} className={`link-row ${link.status}`}>
              <span className={`link-relation ${link.relation}`}>{link.relation}</span>
              <span className="link-other" title={other}>{otherSession ? sessionDisplayTitle(otherSession) : shortId(other, 16)}</span>
              {link.status === 'active' ? (
                <IconButton
                  icon="close"
                  label="关闭连接"
                  onClick={() => onCloseLink(link.linkId)}
                  disabled={busy}
                />
              ) : (
                <Badge tone="muted">已关闭</Badge>
              )}
            </div>
          )
        })}
      </section>

      {joins.length > 0 && (
        <section className="inspector-section">
          <SectionTitle>等待</SectionTitle>
          {joins.map(join => (
            <div key={join.joinId} className="join-row">
              <span className={`join-mode ${join.mode}`}>{join.mode}</span>
              <span className="join-targets">
                {join.targets.map(target => shortId(target, 10)).join(' · ')}
              </span>
              <Badge tone={join.status === 'pending' ? 'warn' : 'muted'}>{join.status}</Badge>
            </div>
          ))}
        </section>
      )}

      {inspection?.lastTs && (
        <section className="inspector-section">
          <SectionTitle>最后事件</SectionTitle>
          <Row label="类型" value={inspection.lastType} />
          <Row label="时间" value={formatDateTime(inspection.lastTs)} />
        </section>
      )}
    </div>
  )
}
