import type { SessionInfo, SessionLink } from '../types'

export interface SessionGroup {
  key: string
  label: string
  sessions: SessionInfo[]
}

export function sessionDisplayTitle(session: SessionInfo): string {
  const title = session.title?.trim()
  if (title) return title
  return session.kind === 'agent' ? '子 agent 会话' : '新会话'
}

export function sessionSearchText(session: SessionInfo): string {
  return `${sessionDisplayTitle(session)} ${session.id} ${session.createdBy ?? ''} ${session.reason ?? ''}`
    .toLowerCase()
}

/** 列表行右侧的短时间，不占太多宽度。 */
export function sessionTime(ts: string | undefined): string {
  if (!ts) return ''
  const time = new Date(ts).getTime()
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 时`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天`
  return new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function dayStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function bucketOf(ts: string, today: number): 'today' | 'yesterday' | 'week' | 'older' {
  const time = new Date(ts).getTime()
  if (Number.isNaN(time) || time >= today) return 'today'
  if (time >= today - 86_400_000) return 'yesterday'
  if (time >= today - 7 * 86_400_000) return 'week'
  return 'older'
}

/**
 * 活跃会话按日期分组；归档/已删除单独放到最后，避免和日常会话混在一起。
 * 搜索时只保留一个结果组。
 */
export function groupSessions(sessions: SessionInfo[], query: string): SessionGroup[] {
  const needle = query.trim().toLowerCase()
  if (needle) {
    const matched = sessions
      .filter(session => sessionSearchText(session).includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return matched.length > 0
      ? [{ key: 'search', label: '搜索结果', sessions: matched }]
      : []
  }

  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const today = dayStart(new Date())
  const buckets: Record<'today' | 'yesterday' | 'week' | 'older', SessionInfo[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  }
  const archived: SessionInfo[] = []
  const deleted: SessionInfo[] = []

  for (const session of sorted) {
    if (session.lifecycle === 'archived') archived.push(session)
    else if (session.lifecycle === 'deleted') deleted.push(session)
    else buckets[bucketOf(session.updatedAt, today)].push(session)
  }

  const groups: SessionGroup[] = [
    { key: 'today', label: '今天', sessions: buckets.today },
    { key: 'yesterday', label: '昨天', sessions: buckets.yesterday },
    { key: 'week', label: '7 天内', sessions: buckets.week },
    { key: 'older', label: '更早', sessions: buckets.older },
    { key: 'archived', label: '归档', sessions: archived },
    { key: 'deleted', label: '已删除', sessions: deleted },
  ]
  return groups.filter(group => group.sessions.length > 0)
}

export interface LinkedSession {
  session: SessionInfo
  relation: SessionLink['relation']
}

/** 选中会话的直接连接；同一会话有多条关系时只保留第一条。 */
export function linkedSessions(
  links: SessionLink[],
  selectedId: string | undefined,
  sessions: SessionInfo[],
): LinkedSession[] {
  if (!selectedId) return []
  const byId = new Map(sessions.map(session => [session.id, session]))
  const seen = new Set<string>()
  const result: LinkedSession[] = []
  for (const link of links) {
    if (link.status !== 'active') continue
    const otherId: string | undefined = link.from === selectedId
      ? link.to
      : link.to === selectedId ? link.from : undefined
    if (!otherId || otherId === selectedId || seen.has(otherId)) continue
    const session = byId.get(otherId)
    if (!session) continue
    seen.add(otherId)
    result.push({ session, relation: link.relation })
  }
  return result
}
