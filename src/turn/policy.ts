import type { Event } from '../core/events.ts'

export interface TurnPolicy {
  readonly name: string
  startsAt(event: Event): boolean
  endsAt(event: Event): boolean
}

/** 默认：用户开口一轮开始，助手回答一轮结束。 */
export const userTurnPolicy: TurnPolicy = {
  name: 'user-turn',
  startsAt: event => event.type === 'message.user',
  endsAt: event => event.type === 'message.assistant',
}

export interface TurnGrouping {
  /** 已闭合的轮，可以安全消费 */
  readonly closed: readonly (readonly Event[])[]
  /** 还没等到结束事件的尾巴，留到下次 */
  readonly open: readonly Event[]
  /** 已闭合部分包含的事件条数，用于推进游标 */
  readonly consumed: number
}

/** 按策略切轮。未闭合的尾巴不消费，保证断点续传不丢不重。 */
export function groupTurns(events: readonly Event[], policy: TurnPolicy): TurnGrouping {
  const closed: Event[][] = []
  let current: Event[] = []
  let consumed = 0

  for (const event of events) {
    if (current.length === 0) {
      if (!policy.startsAt(event)) continue
      current = [event]
      continue
    }

    current.push(event)
    if (policy.endsAt(event)) {
      closed.push(current)
      consumed += current.length
      current = []
    }
  }

  return { closed, open: current, consumed }
}
