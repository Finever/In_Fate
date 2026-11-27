import type { Event, NewEvent } from '../core/events.ts'
import { toolResultPayload } from './result-payload.ts'
import type { ToolResult } from './types.ts'

/** 从已有事件里收集“已经有结果”的调用 id。 */
export function toolCallIdsWithResults(events: readonly Event[]): Set<string> {
  const out = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool.result') continue
    const fromRefs = event.refs?.toolCall
    if (typeof fromRefs === 'string' && fromRefs.length > 0) {
      out.add(fromRefs)
      continue
    }
    const fromPayload = event.payload.callId
    if (typeof fromPayload === 'string' && fromPayload.length > 0) out.add(fromPayload)
  }
  return out
}

export interface RecordToolResultInput {
  readonly append: (event: NewEvent) => Event
  readonly stream: string
  readonly callId: string
  readonly result: ToolResult
  /** 本轮已写过结果的调用 id；命中就跳过 */
  readonly seen: Set<string>
}

/**
 * 写一次结果；已存在就返回 undefined。
 * append 失败时不把 id 放进 seen——让上层按崩溃/未知结果处理。
 */
export function recordToolResultOnce(input: RecordToolResultInput): Event | undefined {
  if (input.seen.has(input.callId)) return undefined
  const event = input.append({
    stream: input.stream,
    actor: 'tool',
    type: 'tool.result',
    refs: { toolCall: input.callId },
    payload: toolResultPayload(input.callId, input.result),
  })
  input.seen.add(input.callId)
  return event
}
