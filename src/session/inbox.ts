/**
 * 会话收件箱的未读边界。
 *
 * `session.message` 是持久化事件，但“是否已经进过某一轮的模型请求”由
 * `turn.completed.lastSeenSeq` 决定。不能用“最后一次 turn.completed 之后”
 * 当边界：消息可能在一轮进行中、模型请求投影之后才落盘，位置会排在那条
 * turn.completed 前面，却从未被看到。
 *
 * 这正是 DSH / Cherry agent loop 的 inbox 语义——消息在 `pre-step` 被
 * claim 之前都算 pending；这里用 `lastSeenSeq` 做同一个判断。
 *
 * @module if/session/inbox
 */

import type { Event } from '../core/events.ts'

export interface PendingSessionMessage {
  readonly position: number
  readonly eventId: string
  readonly messageId: string
  readonly from: string
  readonly kind: string
  readonly text: string
}

interface Positioned {
  readonly event: Event
  readonly position: number
}

/**
 * 事件在会话流里的单调位置。新日志用 seq；旧日志没有 seq 时退回数组下标，
 * 保证同一份日志里的比较始终用同一把尺。
 */
function positioned(events: readonly Event[]): { items: Positioned[]; usesSeq: boolean } {
  const usesSeq = events.every(event => typeof event.seq === 'number')
  return {
    usesSeq,
    items: events.map((event, index) => ({
      event,
      position: usesSeq ? event.seq! : index,
    })),
  }
}

/**
 * 所有完成轮实际送进模型请求的最大位置；没有完成轮返回 -1。
 *
 * 取 max 而不是“最后一轮”：一轮可能因为配置或故障留下更低的
 * lastSeenSeq，但已经被更早的轮看过的消息不该因此重新变成未读。
 */
export function lastSeenPosition(events: readonly Event[]): number {
  const { items, usesSeq } = positioned(events)
  let boundary = -1
  for (const item of items) {
    if (item.event.type !== 'turn.completed') continue
    const seen = item.event.payload.lastSeenSeq
    if (usesSeq && typeof seen === 'number' && Number.isFinite(seen)) {
      boundary = Math.max(boundary, seen)
    } else {
      // 更旧的 turn.completed 没记 lastSeenSeq：保守地认为它看到了自己之前的事件。
      boundary = Math.max(boundary, item.position)
    }
  }
  return boundary
}

/**
 * 尚未被任何完成轮看到的 wake 消息，按落盘顺序返回。
 *
 * 只收 `wake === true`；`note` 不该主动开轮。
 */
export function pendingWakeMessages(events: readonly Event[]): PendingSessionMessage[] {
  const boundary = lastSeenPosition(events)
  const { items } = positioned(events)
  const out: PendingSessionMessage[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const { event, position } = item
    if (event.type !== 'session.message') continue
    if (event.payload.wake !== true) continue
    if (position <= boundary) continue

    const messageId = typeof event.payload.messageId === 'string'
      ? event.payload.messageId
      : event.id
    if (seen.has(messageId)) continue
    seen.add(messageId)

    out.push({
      position,
      eventId: event.id,
      messageId,
      from: typeof event.payload.fromSession === 'string'
        ? event.payload.fromSession
        : (event.refs?.fromSession ?? '?'),
      kind: typeof event.payload.kind === 'string' ? event.payload.kind : 'note',
      text: typeof event.payload.text === 'string' ? event.payload.text : '',
    })
  }

  return out
}
