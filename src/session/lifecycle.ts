import type { Event } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import { assertSafeSessionId } from '../core/safe-path.ts'

export type SessionLifecycleState = 'active' | 'archived' | 'deleted'

export interface SessionLifecycleRecord {
  readonly sessionId: string
  readonly state: SessionLifecycleState
  readonly updatedAt: string
  readonly updatedBy: string
  readonly reason?: string
}

/** 会话正在跑，归档/删除需要等待或 force。 */
export class SessionBusyError extends Error {
  readonly code = 'ESESSIONBUSY'
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`session is running: ${sessionId}; wait for the turn to finish or pass force`)
    this.name = 'SessionBusyError'
    this.sessionId = sessionId
  }
}

export interface SessionLifecycleSnapshot {
  /** 只有显式写过 lifecycle 事件的记录；默认 active 的会话不在这里计数。 */
  readonly archived: number
  readonly deleted: number
  readonly records: SessionLifecycleRecord[]
}

const STATES = new Set<SessionLifecycleState>(['active', 'archived', 'deleted'])

function recordFromEvent(event: Event): SessionLifecycleRecord | undefined {
  if (event.type !== 'session.lifecycle') return undefined
  const payload = event.payload as {
    sessionId?: unknown
    state?: unknown
    updatedAt?: unknown
    updatedBy?: unknown
    reason?: unknown
  }
  if (typeof payload.sessionId !== 'string') return undefined
  if (typeof payload.state !== 'string' || !STATES.has(payload.state as SessionLifecycleState)) {
    return undefined
  }
  return {
    sessionId: payload.sessionId,
    state: payload.state as SessionLifecycleState,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : event.ts,
    updatedBy: typeof payload.updatedBy === 'string' ? payload.updatedBy : 'user',
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
  }
}

export class SessionLifecycle {
  private readonly store: EventStore
  private readonly writer?: SessionWriter
  private readonly byId = new Map<string, SessionLifecycleRecord>()
  private lastEventId: string | undefined
  private lastCount = -1

  constructor(store: EventStore, writer?: SessionWriter) {
    this.store = store
    if (writer) this.writer = writer
    this.refresh()
  }

  /** 没有 lifecycle 事件的会话默认 active。 */
  stateOf(sessionId: string): SessionLifecycleState {
    this.refresh()
    return this.byId.get(sessionId)?.state ?? 'active'
  }

  recordOf(sessionId: string): SessionLifecycleRecord | undefined {
    this.refresh()
    return this.byId.get(sessionId)
  }

  canRun(sessionId: string): boolean {
    return this.stateOf(sessionId) === 'active'
  }

  canMessage(sessionId: string): boolean {
    return this.stateOf(sessionId) === 'active'
  }

  /** archived 仍可读历史；deleted 不可。 */
  canRead(sessionId: string): boolean {
    return this.stateOf(sessionId) !== 'deleted'
  }

  archive(sessionId: string, updatedBy = 'user', reason?: string): SessionLifecycleRecord {
    assertSafeSessionId(sessionId)
    const current = this.stateOf(sessionId)
    if (current === 'deleted') throw new Error(`session is deleted: ${sessionId}`)
    if (current === 'archived') return this.byId.get(sessionId)!
    return this.write(sessionId, 'archived', updatedBy, reason)
  }

  unarchive(sessionId: string, updatedBy = 'user', reason?: string): SessionLifecycleRecord {
    assertSafeSessionId(sessionId)
    const current = this.stateOf(sessionId)
    if (current === 'deleted') throw new Error(`session is deleted: ${sessionId}`)
    if (current === 'active') {
      return this.byId.get(sessionId) ?? {
        sessionId,
        state: 'active',
        updatedAt: new Date().toISOString(),
        updatedBy,
      }
    }
    return this.write(sessionId, 'active', updatedBy, reason)
  }

  /** 软删除，终态；不允许再 archive/unarchive。 */
  delete(sessionId: string, updatedBy = 'user', reason?: string): SessionLifecycleRecord {
    assertSafeSessionId(sessionId)
    const current = this.stateOf(sessionId)
    if (current === 'deleted') return this.byId.get(sessionId)!
    return this.write(sessionId, 'deleted', updatedBy, reason)
  }

  snapshot(): SessionLifecycleSnapshot {
    this.refresh()
    const records = [...this.byId.values()]
    return {
      archived: records.filter(record => record.state === 'archived').length,
      deleted: records.filter(record => record.state === 'deleted').length,
      records,
    }
  }

  private write(
    sessionId: string,
    state: SessionLifecycleState,
    updatedBy: string,
    reason?: string,
  ): SessionLifecycleRecord {
    const record: SessionLifecycleRecord = {
      sessionId,
      state,
      updatedAt: new Date().toISOString(),
      updatedBy,
      ...(reason ? { reason } : {}),
    }
    this.append({
      stream: 'workspace:default',
      actor: 'system',
      type: 'session.lifecycle',
      refs: { session: sessionId },
      payload: record as unknown as Record<string, unknown>,
    })
    this.byId.set(sessionId, record)
    return record
  }

  private append(input: Parameters<EventStore['append']>[0]): Event {
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
    this.byId.clear()
    for (const event of events) {
      const record = recordFromEvent(event)
      if (record) this.byId.set(record.sessionId, record)
    }
    this.lastCount = events.length
    this.lastEventId = events.at(-1)?.id
  }
}
