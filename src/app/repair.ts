/**
 * 崩溃后的会话修复。
 *
 * 只处理“最后一个 completed 之后还有用户消息”的尾巴：
 *   - 未配对的 tool.call 写 TOOL_OUTCOME_UNKNOWN，不自动重试
 *   - 补一条 aborted 的 turn.completed
 *
 * 不改已有事件；修完再 flush。重复调用是幂等的。
 *
 * @module if/app/repair
 */

import type { Event, NewEvent } from '../core/events.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import type { EventStore } from '../core/store.ts'

export interface RepairResult {
  readonly closedTurn: boolean
  readonly unknownResults: number
}

export interface ApprovalRepairResult {
  readonly cancelled: number
}

const UNKNOWN_TOOL_TEXT = '工具结果未知：进程在工具执行期间中断，无法确认该调用是否完成。'
  + '不要自动重试有副作用的调用；只读或幂等操作可以重新执行。'

export function repairInterruptedSession(
  store: EventStore,
  writer?: SessionWriter,
): RepairResult {
  const events = store.read()
  if (events.length === 0) return { closedTurn: false, unknownResults: 0 }

  let lastCompleted = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === 'turn.completed') {
      lastCompleted = index
      break
    }
  }

  const tail = events.slice(lastCompleted + 1)
  if (!tail.some(event => event.type === 'message.user')) {
    return { closedTurn: false, unknownResults: 0 }
  }

  const pending = new Map<string, Event>()
  for (const event of tail) {
    if (event.type === 'tool.call') {
      pending.set(String(event.payload.callId ?? event.id), event)
      continue
    }
    if (event.type === 'tool.result') {
      pending.delete(String(event.payload.callId ?? event.refs?.toolCall ?? ''))
    }
  }

  const append = (input: NewEvent): Event =>
    writer ? writer.append(input) : store.append(input)
  const stream = tail[0]!.stream

  for (const [callId, call] of pending) {
    append({
      stream,
      actor: 'tool',
      type: 'tool.result',
      refs: { toolCall: callId },
      payload: {
        callId,
        text: `${UNKNOWN_TOOL_TEXT}\n工具：${String(call.payload.call ?? 'unknown')}`,
        isError: true,
        code: 'TOOL_OUTCOME_UNKNOWN',
      },
    })
  }

  append({
    stream,
    actor: 'system',
    type: 'turn.completed',
    payload: {
      steps: 0,
      usage: { input: 0, output: 0, cacheRead: 0 },
      aborted: true,
      hitLimit: false,
      status: 'cancelled',
      error: 'process restarted',
    },
  })

  if (writer) writer.flush()
  else store.flush()

  return { closedTurn: true, unknownResults: pending.size }
}

/**
 * 重启后不恢复待审批：阻塞中的工具调用已经无法继续。
 * 给每个 asked 无 decided 的审批补一条 restart 拒绝，避免幽灵审批。
 */
export function settleInterruptedApprovals(
  store: EventStore,
  writer?: SessionWriter,
): ApprovalRepairResult {
  const events = store.read()
  const open = new Map<string, { stream: string; payload: Record<string, unknown> }>()

  for (const event of events) {
    const approvalId = String(event.payload.approvalId ?? '')
    if (!approvalId) continue
    if (event.type === 'approval.asked') {
      open.set(approvalId, { stream: event.stream, payload: event.payload })
      continue
    }
    if (event.type === 'approval.decided') open.delete(approvalId)
  }

  if (open.size === 0) return { cancelled: 0 }

  const append = (input: NewEvent): Event =>
    writer ? writer.append(input) : store.append(input)

  for (const [approvalId, entry] of open) {
    append({
      stream: entry.stream,
      actor: 'system',
      type: 'approval.decided',
      payload: {
        approvalId,
        approved: false,
        reason: 'process restarted',
        source: 'restart',
        resolvedAt: new Date().toISOString(),
      },
    })
  }

  if (writer) writer.flush()
  else store.flush()

  return { cancelled: open.size }
}
