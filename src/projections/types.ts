import type { Event } from '../core/events.ts'
import type { Profile } from '../config/profile.ts'

export interface ProjectionContext {
  readonly profile: Profile
  readonly sessionId: string
  /** 这一轮是第几轮（从 1 起） */
  readonly turn: number
  /** 投影执行的时刻，用于计算“今天”等易变事实 */
  readonly now: Date
}

export interface Projection<T = unknown> {
  readonly name: string
  /** 订阅哪些事件类型 */
  handles(type: string): boolean
  /** 一条事件可能产出零到多行；轮次号由上下文给。 */
  map(event: Event, context: ProjectionContext): T | readonly T[] | void
}
