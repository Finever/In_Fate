/**
 * IF 的核心事件契约。
 *
 * envelope 只放所有事件共有的不变量；具体正文一律进 payload。
 * 内置类型只是默认套餐，扩展类型走 `x.` 命名空间，不改这个文件。
 *
 * @module if/core/events
 */

/** envelope 版本。字段语义变化时递增，并配一条迁移。 */
export const ENVELOPE_VERSION = 1

/** 内置事件类型。扩展类型不在这里加。 */
export type CoreEventType =
  | 'session.created'
  | 'session.lifecycle'
  | 'session.meta'
  | 'session.link'
  | 'session.link.closed'
  | 'session.message'
  | 'session.join'
  | 'session.join.done'
  | 'session.join.timeout'
  | 'session.join.cancelled'
  | 'message.user'
  | 'message.system'
  | 'message.assistant'
  | 'thoughts.segment'
  | 'tool.call'
  | 'tool.result'
  | 'approval.asked'
  | 'approval.decided'
  | 'task.created'
  | 'task.updated'
  | 'token.recorded'
  | 'turn.completed'
  | 'context.injected'
  | 'context.compacted'
  | 'compaction.pruned'
  | 'compaction.failed'

/** 允许任意字符串，同时保留内置类型的补全。扩展类型用 `x.` 前缀。 */
export type EventType = CoreEventType | (string & {})

/** 基础角色。具体身份放 actorId；角色本身可扩展。 */
export type Actor = 'user' | 'agent' | 'tool' | 'system' | (string & {})

/** 一条事件。写入后不可修改。 */
export interface Event {
  /** envelope 版本 */
  readonly v: number
  /** 该事件类型自己的版本，默认由注册表给 */
  readonly tv?: number
  /** 会话内单调序号；旧日志可能没有 */
  readonly seq?: number
  /** 事件 id，无序；顺序看文件行 */
  readonly id: string
  /** ISO UTC 毫秒 */
  readonly ts: string
  /** 聚合地址：`session:<id>` / `task:<id>` / `process:<id>` / `agent:<id>` */
  readonly stream: string
  /** 角色 */
  readonly actor: Actor
  /** 具体是谁：用户 id、agent id */
  readonly actorId?: string
  /** 事件类型 */
  readonly type: EventType
  /** 跨聚合引用，只放 id，不放对象 */
  readonly refs?: Readonly<Record<string, string>>
  /** 事件正文，只放事实 */
  readonly payload: Readonly<Record<string, unknown>>
}

/** 追加事件的输入。envelope 的公共字段由 store 补。 */
export interface NewEvent {
  readonly stream: string
  readonly actor: Actor
  readonly actorId?: string
  readonly type: EventType
  readonly refs?: Readonly<Record<string, string>>
  readonly payload: Readonly<Record<string, unknown>>
}
