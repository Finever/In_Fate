import type { Event } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import { assertSafeSessionId } from '../core/safe-path.ts'

export interface SessionMeta {
  readonly sessionId: string
  readonly category?: string
  readonly pinned?: boolean
  /** 会话级 assistant 接续前缀；只在支持 prefill 的模型接口上生效。 */
  readonly thinkingHead?: string
  readonly thinkingHeadEnabled?: boolean
  readonly updatedAt: string
  readonly updatedBy: string
}

export interface SessionMetaPatch {
  /** null / 空串 = 取消分类 */
  readonly category?: string | null
  readonly pinned?: boolean
  /** null / 空串 = 清除思考头 */
  readonly thinkingHead?: string | null
  readonly thinkingHeadEnabled?: boolean
}

const MAX_CATEGORY_CHARS = 40
const MAX_THINKING_HEAD_CHARS = 2000

function normalizeCategory(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > MAX_CATEGORY_CHARS) {
    throw new Error(`session category too long (max ${MAX_CATEGORY_CHARS})`)
  }
  return text
}

function normalizeThinkingHead(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > MAX_THINKING_HEAD_CHARS) {
    throw new Error(`thinking head too long (max ${MAX_THINKING_HEAD_CHARS})`)
  }
  return text
}

function recordFromEvent(event: Event): SessionMeta | undefined {
  if (event.type !== 'session.meta') return undefined
  const payload = event.payload as {
    sessionId?: unknown
    category?: unknown
    pinned?: unknown
    thinkingHead?: unknown
    thinkingHeadEnabled?: unknown
    updatedAt?: unknown
    updatedBy?: unknown
  }
  if (typeof payload.sessionId !== 'string') return undefined
  const category = typeof payload.category === 'string' && payload.category.trim()
    ? payload.category.trim()
    : undefined
  const thinkingHead = typeof payload.thinkingHead === 'string' && payload.thinkingHead.trim()
    ? payload.thinkingHead.trim()
    : undefined
  return {
    sessionId: payload.sessionId,
    ...(category ? { category } : {}),
    ...(payload.pinned === true ? { pinned: true } : {}),
    ...(thinkingHead ? { thinkingHead } : {}),
    ...(payload.thinkingHeadEnabled === true ? { thinkingHeadEnabled: true } : {}),
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : event.ts,
    updatedBy: typeof payload.updatedBy === 'string' ? payload.updatedBy : 'user',
  }
}

export class SessionMetaStore {
  private readonly store: EventStore
  private readonly writer?: SessionWriter
  private readonly now: () => Date
  private readonly byId = new Map<string, SessionMeta>()
  private lastEventId: string | undefined
  private lastCount = -1

  constructor(store: EventStore, writer?: SessionWriter, options: { now?: () => Date } = {}) {
    this.store = store
    if (writer) this.writer = writer
    this.now = options.now ?? (() => new Date())
    this.refresh()
  }

  metaOf(sessionId: string): SessionMeta | undefined {
    this.refresh()
    return this.byId.get(sessionId)
  }

  set(
    sessionId: string,
    patch: SessionMetaPatch,
    updatedBy = 'user',
  ): SessionMeta {
    assertSafeSessionId(sessionId)
    const current = this.metaOf(sessionId)
    const category = patch.category === undefined
      ? current?.category
      : normalizeCategory(patch.category)
    const pinned = patch.pinned === undefined ? current?.pinned : patch.pinned
    const thinkingHead = patch.thinkingHead === undefined
      ? current?.thinkingHead
      : normalizeThinkingHead(patch.thinkingHead)
    const thinkingHeadEnabled = thinkingHead
      ? (patch.thinkingHeadEnabled === undefined
        ? current?.thinkingHeadEnabled
        : patch.thinkingHeadEnabled)
      : undefined
    if (
      category === current?.category
      && pinned === current?.pinned
      && thinkingHead === current?.thinkingHead
      && thinkingHeadEnabled === current?.thinkingHeadEnabled
    ) {
      return current ?? {
        sessionId,
        ...(category ? { category } : {}),
        ...(pinned ? { pinned: true } : {}),
        ...(thinkingHead ? { thinkingHead } : {}),
        ...(thinkingHeadEnabled ? { thinkingHeadEnabled: true } : {}),
        updatedAt: this.now().toISOString(),
        updatedBy,
      }
    }
    const record: SessionMeta = {
      sessionId,
      ...(category ? { category } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(thinkingHead ? { thinkingHead } : {}),
      ...(thinkingHeadEnabled ? { thinkingHeadEnabled: true } : {}),
      updatedAt: this.now().toISOString(),
      updatedBy,
    }
    this.append({
      stream: 'workspace:default',
      actor: 'system',
      type: 'session.meta',
      refs: { session: sessionId },
      payload: record as unknown as Record<string, unknown>,
    })
    this.byId.set(sessionId, record)
    return record
  }

  categories(): string[] {
    this.refresh()
    return [...new Set(
      [...this.byId.values()]
        .map(meta => meta.category)
        .filter((category): category is string => Boolean(category)),
    )].sort((a, b) => a.localeCompare(b, 'zh'))
  }

  snapshot(): readonly SessionMeta[] {
    this.refresh()
    return [...this.byId.values()]
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