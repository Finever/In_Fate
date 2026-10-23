/**
 * 跨会话消息契约。
 *
 * 消息只写目标会话的收件箱；来源会话不写副本。
 *
 * @module if/session/message
 */

export type SessionMessageKind = 'note' | 'question' | 'result' | 'wake'

export interface SendSessionMessageInput {
  readonly from: string
  readonly to: string
  readonly text: string
  readonly kind?: SessionMessageKind
  /** 不传就在 from/to 之间找一条可发送的 active link */
  readonly linkId?: string
  readonly replyTo?: string
  readonly hop?: number
  /** 目标空闲时是否自动开一轮；默认 question/result/wake 为 true */
  readonly wake?: boolean
}

export interface SessionMessageDelivery {
  readonly messageId: string
  readonly eventId: string
  readonly linkId: string
  readonly woke: boolean
}
