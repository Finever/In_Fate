/**
 * 会话连接图。
 *
 * 连接是独立的 workspace 事件流，不是某个会话的私产：
 *   - 所有会话归用户所有；
 *   - link 只描述“谁可以读/发消息给谁”，不决定调度；
 *   - createdBy 只做溯源，不产生权限或父子关系。
 *
 * @module if/graph/links
 */

import { randomUUID } from 'node:crypto'
import type { Event, NewEvent } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import { assertSafeSessionId } from '../core/safe-path.ts'

export type LinkRelation = 'peer' | 'handoff' | 'reference'

export interface LinkSidePermissions {
  readonly read: boolean
  readonly message: boolean
}

export interface LinkPermissions {
  /** from 对 to 的权限 */
  readonly from: LinkSidePermissions
  /** to 对 from 的权限 */
  readonly to: LinkSidePermissions
}

export interface SessionLink {
  readonly linkId: string
  readonly from: string
  readonly to: string
  readonly relation: LinkRelation
  readonly permissions: LinkPermissions
  /** handoff/reference 的快照位置；不填表示当前 */
  readonly snapshotSeq?: number
  readonly createdBy: string
  readonly createdAt: string
  readonly reason?: string
  readonly status: 'active' | 'closed'
  readonly closedAt?: string
  readonly closedBy?: string
  readonly closeReason?: string
}

export interface CreateLinkInput {
  readonly from: string
  readonly to: string
  readonly relation?: LinkRelation
  readonly permissions?: Partial<Record<'from' | 'to', Partial<LinkSidePermissions>>>
  readonly snapshotSeq?: number
  readonly createdBy?: string
  readonly reason?: string
}

export interface LinkQuery {
  readonly includeClosed?: boolean
}

const RELATIONS = new Set<LinkRelation>(['peer', 'handoff', 'reference'])

const DEFAULT_PERMISSIONS: Record<LinkRelation, LinkPermissions> = {
  peer: {
    from: { read: true, message: true },
    to: { read: true, message: true },
  },
  handoff: {
    from: { read: false, message: true },
    to: { read: true, message: false },
  },
  reference: {
    from: { read: false, message: false },
    to: { read: true, message: false },
  },
}

export function defaultLinkPermissions(relation: LinkRelation): LinkPermissions {
  return DEFAULT_PERMISSIONS[relation]
}

function permissionsFor(
  relation: LinkRelation,
  input: CreateLinkInput['permissions'],
): LinkPermissions {
  const base = DEFAULT_PERMISSIONS[relation]
  return {
    from: { ...base.from, ...(input?.from ?? {}) },
    to: { ...base.to, ...(input?.to ?? {}) },
  }
}

function assertRelation(value: string): LinkRelation {
  if (!RELATIONS.has(value as LinkRelation)) {
    throw new Error(`unknown link relation: ${value}`)
  }
  return value as LinkRelation
}

function linkFromEvent(event: Event): SessionLink | undefined {
  const payload = event.payload as {
    linkId?: unknown
    from?: unknown
    to?: unknown
    relation?: unknown
    permissions?: LinkPermissions
    snapshotSeq?: unknown
    createdBy?: unknown
    createdAt?: unknown
    reason?: unknown
  }
  if (typeof payload.linkId !== 'string') return undefined
  if (typeof payload.from !== 'string' || typeof payload.to !== 'string') return undefined
  if (typeof payload.relation !== 'string') return undefined

  return {
    linkId: payload.linkId,
    from: payload.from,
    to: payload.to,
    relation: assertRelation(payload.relation),
    permissions: payload.permissions ?? DEFAULT_PERMISSIONS[assertRelation(payload.relation)],
    ...(typeof payload.snapshotSeq === 'number' ? { snapshotSeq: payload.snapshotSeq } : {}),
    createdBy: typeof payload.createdBy === 'string' ? payload.createdBy : 'user',
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : event.ts,
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    status: 'active',
  }
}

export class SessionGraph {
  private readonly store: EventStore
  private readonly writer?: SessionWriter
  private readonly byId = new Map<string, SessionLink>()
  private lastEventId: string | undefined
  private lastCount = -1

  constructor(store: EventStore, writer?: SessionWriter) {
    this.store = store
    if (writer) this.writer = writer
    this.refresh()
  }

  create(input: CreateLinkInput): SessionLink {
    assertSafeSessionId(input.from)
    assertSafeSessionId(input.to)
    if (input.from === input.to) throw new Error('link cannot point to itself')

    const relation = assertRelation(input.relation ?? 'peer')
    const permissions = permissionsFor(relation, input.permissions)
    const existing = this.findActive(input.from, input.to, relation)
    if (existing) return existing

    const link: SessionLink = {
      linkId: `link-${randomUUID()}`,
      from: input.from,
      to: input.to,
      relation,
      permissions,
      ...(input.snapshotSeq !== undefined ? { snapshotSeq: input.snapshotSeq } : {}),
      createdBy: input.createdBy ?? 'user',
      createdAt: new Date().toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
      status: 'active',
    }

    this.append({
      stream: 'workspace:default',
      actor: 'system',
      type: 'session.link',
      refs: { from: link.from, to: link.to },
      payload: link as unknown as Record<string, unknown>,
    })
    this.byId.set(link.linkId, link)
    return link
  }

  close(linkId: string, closedBy = 'user', reason?: string): SessionLink | undefined {
    this.refresh()
    const current = this.byId.get(linkId)
    if (!current || current.status === 'closed') return current

    const closedAt = new Date().toISOString()
    this.append({
      stream: 'workspace:default',
      actor: 'system',
      type: 'session.link.closed',
      refs: { link: linkId, from: current.from, to: current.to },
      payload: {
        linkId,
        closedBy,
        closedAt,
        ...(reason ? { reason } : {}),
      },
    })

    const next: SessionLink = {
      ...current,
      status: 'closed',
      closedAt,
      closedBy,
      ...(reason ? { closeReason: reason } : {}),
    }
    this.byId.set(linkId, next)
    return next
  }

  get(linkId: string): SessionLink | undefined {
    this.refresh()
    return this.byId.get(linkId)
  }

  links(sessionId?: string, options: LinkQuery = {}): SessionLink[] {
    this.refresh()
    const includeClosed = options.includeClosed ?? true
    return [...this.byId.values()]
      .filter(link => includeClosed || link.status === 'active')
      .filter(link => !sessionId || link.from === sessionId || link.to === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  canRead(actor: string, target: string): boolean {
    this.refresh()
    for (const link of this.byId.values()) {
      if (link.status !== 'active') continue
      if (link.from === actor && link.to === target && link.permissions.from.read) return true
      if (link.to === actor && link.from === target && link.permissions.to.read) return true
    }
    return false
  }

  canMessage(from: string, to: string): boolean {
    this.refresh()
    for (const link of this.byId.values()) {
      if (link.status !== 'active') continue
      if (link.from === from && link.to === to && link.permissions.from.message) return true
      if (link.to === from && link.from === to && link.permissions.to.message) return true
    }
    return false
  }

  /** 当前图快照；UI/CLI 用。 */
  snapshot(): { links: SessionLink[]; active: number; closed: number } {
    const all = this.links()
    return {
      links: all,
      active: all.filter(link => link.status === 'active').length,
      closed: all.filter(link => link.status === 'closed').length,
    }
  }

  private findActive(from: string, to: string, relation: LinkRelation): SessionLink | undefined {
    this.refresh()
    for (const link of this.byId.values()) {
      if (
        link.status === 'active'
        && link.from === from
        && link.to === to
        && link.relation === relation
      ) {
        return link
      }
    }
    return undefined
  }

  private append(input: NewEvent): Event {
    const event = this.writer ? this.writer.append(input) : this.store.append(input)
    if (this.writer) this.writer.flush()
    else this.store.flush()
    this.lastEventId = event.id
    this.lastCount += 1
    return event
  }

  private refresh(): void {
    const events = this.store.read()
    const last = events.at(-1)?.id
    if (events.length === this.lastCount && last === this.lastEventId) return
    this.rebuild(events)
  }

  private rebuild(events: readonly Event[]): void {
    this.byId.clear()
    for (const event of events) {
      if (event.type === 'session.link') {
        const link = linkFromEvent(event)
        if (link) this.byId.set(link.linkId, link)
        continue
      }
      if (event.type === 'session.link.closed') {
        const linkId = event.payload.linkId
        if (typeof linkId !== 'string') continue
        const current = this.byId.get(linkId)
        if (!current) continue
        this.byId.set(linkId, {
          ...current,
          status: 'closed',
          ...(typeof event.payload.closedAt === 'string' ? { closedAt: event.payload.closedAt } : {}),
          ...(typeof event.payload.closedBy === 'string' ? { closedBy: event.payload.closedBy } : {}),
          ...(typeof event.payload.reason === 'string' ? { closeReason: event.payload.reason } : {}),
        })
      }
    }
    this.lastCount = events.length
    this.lastEventId = events.at(-1)?.id
  }
}
