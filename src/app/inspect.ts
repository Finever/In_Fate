import type { Event } from '../core/events.ts'
import type { SessionLink } from '../graph/links.ts'
import type { SessionJoinSnapshot } from '../session/joins.ts'
import type { SessionLifecycleState } from '../session/lifecycle.ts'
import { sessionStateOf, type SessionInfo } from './session.ts'

export interface SessionEventView {
  readonly seq: number
  readonly id: string
  readonly ts: string
  readonly type: string
  readonly actor: string
  readonly actorId?: string
  readonly refs?: Readonly<Record<string, string>>
  readonly preview: string
}

export interface SessionTailOptions {
  /** 只返回该 seq 之后的事件；不传就从尾部取 limit 条 */
  readonly afterSeq?: number
  readonly limit?: number
}

export interface SessionTail {
  readonly sessionId: string
  readonly events: SessionEventView[]
  readonly nextSeq: number
  readonly eof: boolean
  readonly total: number
}

export interface PendingToolCall {
  readonly callId: string
  readonly name: string
}

export interface SessionInspection {
  readonly sessionId: string
  readonly createdBy?: string
  readonly createdFrom?: { readonly sessionId: string; readonly eventId?: string }
  readonly reason?: string
  readonly kind?: 'user' | 'agent'
  readonly lifecycle: SessionLifecycleState
  readonly state: 'idle' | 'running' | 'waiting' | 'done' | 'unknown'
  readonly events: number
  readonly lastSeq: number
  readonly lastType?: string
  readonly lastTs?: string
  readonly lastTurnSeq?: number
  readonly pendingToolCalls: PendingToolCall[]
  readonly links?: readonly SessionLink[]
  readonly joins?: readonly SessionJoinSnapshot[]
}

function clip(text: string, max = 240): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

function payloadText(event: Event): string {
  const text = event.payload.text
  return typeof text === 'string' ? text : ''
}

/** 事件预览：够看清在干什么，不把全文塞进调试输出。 */
export function previewEvent(event: Event): string {
  switch (event.type) {
    case 'message.user':
    case 'message.assistant':
    case 'message.system':
    case 'thoughts.segment':
      return clip(payloadText(event))
    case 'session.message': {
      const from = typeof event.payload.fromSession === 'string' ? event.payload.fromSession : '?'
      const kind = typeof event.payload.kind === 'string' ? event.payload.kind : 'note'
      return clip(`${from}/${kind} ${payloadText(event)}`)
    }
    case 'tool.call': {
      const call = String(event.payload.call ?? '')
      const args = event.payload.args
      const serialized = args === undefined ? '' : JSON.stringify(args)
      return clip(`${call} ${serialized}`)
    }
    case 'tool.result': {
      const mark = event.payload.isError ? 'error' : 'ok'
      return clip(`${mark} ${payloadText(event)}`)
    }
    case 'turn.completed': {
      const steps = event.payload.steps
      const aborted = event.payload.aborted ? ' aborted' : ''
      const error = typeof event.payload.error === 'string' ? ` ${event.payload.error}` : ''
      return clip(`steps=${String(steps ?? '?')}${aborted}${error}`)
    }
    case 'session.created': {
      const by = typeof event.payload.createdBy === 'string' ? event.payload.createdBy : 'unknown'
      return `createdBy=${by}`
    }
    case 'session.link': {
      const relation = String(event.payload.relation ?? 'link')
      const from = String(event.payload.from ?? event.refs?.from ?? '?')
      const to = String(event.payload.to ?? event.refs?.to ?? '?')
      return `${relation} ${from} -> ${to}`
    }
    case 'session.link.closed':
      return `closed ${String(event.payload.linkId ?? event.refs?.link ?? '?')}`
    case 'approval.asked': {
      const reason = typeof event.payload.reason === 'string' && event.payload.reason
        ? ` · ${event.payload.reason}`
        : ''
      return `ask ${String(event.payload.toolName ?? '?')}${reason}`
    }
    case 'approval.decided':
      return `decided ${event.payload.approved ? 'approved' : 'denied'}`
    default:
      return clip(JSON.stringify(event.payload))
  }
}

function seqOf(event: Event, index: number): number {
  return typeof event.seq === 'number' ? event.seq : index
}

function view(event: Event, index: number): SessionEventView {
  return {
    seq: seqOf(event, index),
    id: event.id,
    ts: event.ts,
    type: event.type,
    actor: event.actor,
    ...(event.actorId ? { actorId: event.actorId } : {}),
    ...(event.refs ? { refs: event.refs } : {}),
    preview: previewEvent(event),
  }
}

export function tailSession(
  sessionId: string,
  events: readonly Event[],
  options: SessionTailOptions = {},
): SessionTail {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)))
  const views = events.map(view)
  const after = options.afterSeq
  const start = after === undefined
    ? Math.max(0, views.length - limit)
    : views.findIndex(item => item.seq > after)
  const slice = start < 0 ? [] : views.slice(start, start + limit)
  const last = slice.at(-1)
  const remaining = start < 0 ? 0 : views.length - (start + slice.length)
  return {
    sessionId,
    events: slice,
    nextSeq: last?.seq ?? (after ?? -1),
    eof: remaining <= 0,
    total: views.length,
  }
}

export interface InspectEventsOptions {
  /** 事件总数；尾读时用 lastSeq + 1，不拿尾段长度冒充全量 */
  readonly totalEvents?: number
  /** 只读了文件尾部；没有 turn.completed 时按最后一条事件判断状态 */
  readonly truncated?: boolean
}

export function inspectEvents(
  sessionId: string,
  events: readonly Event[],
  info?: SessionInfo,
  options: InspectEventsOptions = {},
): SessionInspection {
  let lastTurnIndex = -1
  let lastStartIndex = -1
  events.forEach((event, index) => {
    if (event.type === 'turn.completed') lastTurnIndex = index
    if (
      event.type === 'message.user'
      || event.type === 'message.system'
      || event.type === 'session.message'
    ) lastStartIndex = index
  })

  const lastType = events.at(-1)?.type
  const agentTerminal = lastType === 'agent.completed'
    || lastType === 'agent.failed'
    || lastType === 'agent.cancelled'
    || lastType === 'agent.interrupted'

  const lastTurn = lastTurnIndex >= 0 ? events[lastTurnIndex] : undefined
  const waiting = lastTurn?.payload.status === 'waiting'
    && lastTurnIndex >= lastStartIndex

  const lastEvent = events.at(-1)
  const state: SessionInspection['state'] = events.length === 0
    ? 'unknown'
    : options.truncated === true
      // 尾段可能从一轮中间开始：索引判断不可靠，按最后一条事件判断。
      ? sessionStateOf(lastEvent)
      : agentTerminal
        ? 'done'
        : waiting
          ? 'waiting'
          : lastStartIndex > lastTurnIndex ? 'running' : 'idle'

  const pending = new Map<string, PendingToolCall>()
  for (let index = lastTurnIndex + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'tool.call') {
      const callId = String(event.payload.callId ?? event.id)
      pending.set(callId, { callId, name: String(event.payload.call ?? '') })
    } else if (event.type === 'tool.result') {
      const callId = String(event.payload.callId ?? event.refs?.toolCall ?? '')
      pending.delete(callId)
    }
  }

  const last = lastEvent
  return {
    sessionId,
    ...(info?.createdBy ? { createdBy: info.createdBy } : {}),
    ...(info?.createdFrom ? { createdFrom: info.createdFrom } : {}),
    ...(info?.reason ? { reason: info.reason } : {}),
    ...(info?.kind ? { kind: info.kind } : {}),
    lifecycle: info?.lifecycle ?? 'active',
    state,
    events: options.totalEvents ?? events.length,
    lastSeq: last
      ? (typeof last.seq === 'number'
          ? last.seq
          : (options.totalEvents !== undefined ? options.totalEvents - 1 : events.length - 1))
      : -1,
    ...(last ? { lastType: last.type, lastTs: last.ts } : {}),
    ...(lastTurnIndex >= 0
      ? { lastTurnSeq: seqOf(events[lastTurnIndex]!, lastTurnIndex) }
      : {}),
    pendingToolCalls: [...pending.values()],
  }
}
