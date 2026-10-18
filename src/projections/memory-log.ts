/**
 * 事件 → 记忆库 log 行。
 *
 * 只抄不判断：不摘要、不打标签。名字从 profile 的 principals 解析，
 * 查不到就写 id，绝不写默认人名。
 *
 * @module if/projections/memory-log
 */

import type { Event } from '../core/events.ts'
import type { Profile } from '../config/profile.ts'
import type { Projection, ProjectionContext } from './types.ts'

export type MemoryLogLine = Record<string, unknown>

/** ISO UTC → 记忆 log 用的本地时间。 */
function timeOf(ts: string, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts))
}

/** 按 id 查名字；查不到返回 id 本身。 */
function nameOf(id: string | undefined, profile: Profile, fallback: string): string {
  if (!id) return fallback
  if (profile.principals.user?.id === id) {
    return profile.principals.user.name ?? id
  }
  const agent = profile.principals.agents?.find(item => item.id === id)
  return agent?.name ?? id
}

function textOf(event: Event): string {
  return String(event.payload.text ?? '')
}

export const memoryLogProjection: Projection<MemoryLogLine> = {
  name: 'memory-log',

  handles(type: string): boolean {
    return type === 'message.user' || type === 'message.assistant' || type === 'tool.call'
  },

  map(event: Event, context: ProjectionContext): MemoryLogLine | void {
    if (event.type === 'message.user') {
      return {
        n: context.turn,
        who: nameOf(event.actorId, context.profile, 'user'),
        ts: timeOf(event.ts, context.profile.timeZone),
        text: textOf(event),
      }
    }

    if (event.type === 'message.assistant') {
      return {
        n: context.turn,
        who: nameOf(event.actorId, context.profile, 'agent'),
        type: 'text',
        p: textOf(event),
      }
    }

    if (event.type === 'tool.call') {
      return {
        n: context.turn,
        type: 'tool',
        call: String(event.payload.call ?? ''),
        hint: String(event.payload.hint ?? ''),
        args: event.payload.args ?? {},
      }
    }
  },
}
