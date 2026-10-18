/**
 * 会话历史投影：事件流 → 模型无关的消息数组。
 *
 * 纯函数。不读当前时间、不裁剪、不摘要。绝对时间只放在消息前，
 * 工具与思考只带耗时（由事件 payload 给），不写进文本。
 * 悬空 tool_use 补一条中断结果——否则模型 API 会拒收。
 *
 * @module if/projections/history
 */

import type { Event } from '../core/events.ts'

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly toolUseId: string
  readonly content: string
  readonly isError?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly reasoning?: string
  /** 消息来自哪条事件，审计用；渲染给模型前去掉 */
  readonly sourceEventId?: string
  /** 定时任务推来的 system 消息标 scheduled */
  readonly origin?: 'user' | 'scheduled' | 'agent'
}

export interface ToolMessage {
  readonly role: 'tool'
  readonly toolUseId: string
  readonly content: string
  readonly isError?: boolean
  readonly sourceEventId?: string
}

export type HistoryMessage = ChatMessage | ToolMessage

export interface HistoryOptions {
  /** 是否把 thoughts.segment 并进 assistant.reasoning。默认 false。 */
  readonly includeReasoning?: boolean
  /** 是否在消息前加时间标签。默认 true。 */
  readonly timeTag?: boolean
  /** 渲染时间用的时区 */
  readonly timeZone?: string
  /** 悬空 tool_use 是否补中断结果。默认 true。 */
  readonly fillMissingToolResults?: boolean
}

/** `[2026-10-18 19:51] `，带年份。 */
export function formatTimeTag(ts: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts))

  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `[${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}] `
}

function textOf(event: Event): string {
  return String(event.payload.text ?? '')
}

/** 投影。输入事件数组，输出消息数组；同样的输入永远同样的输出。 */
export function projectHistory(
  events: readonly Event[],
  options: HistoryOptions = {},
): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  const pending = new Map<string, ChatMessage>()
  const fulfilled = new Set<string>()

  const includeReasoning = options.includeReasoning ?? false
  const addTime = options.timeTag ?? true
  const timeZone = options.timeZone ?? 'Asia/Shanghai'

  let currentAssistant: ChatMessage | undefined

  const tag = (event: Event): string => (addTime ? formatTimeTag(event.ts, timeZone) : '')

  const openAssistant = (event: Event): ChatMessage => {
    if (currentAssistant) return currentAssistant
    currentAssistant = { role: 'assistant', content: [], sourceEventId: event.id }
    messages.push(currentAssistant)
    return currentAssistant
  }

  for (const event of events) {
    switch (event.type) {
      case 'message.user':
      case 'message.system': {
        currentAssistant = undefined
        const scheduled = event.type === 'message.system'
        messages.push({
          role: scheduled ? 'system' : 'user',
          content: [{ type: 'text', text: tag(event) + textOf(event) }],
          sourceEventId: event.id,
          origin: scheduled ? 'scheduled' : 'user',
        })
        break
      }

      case 'message.assistant': {
        const message = openAssistant(event)
        message.content.push({ type: 'text', text: tag(event) + textOf(event) })
        break
      }

      case 'thoughts.segment': {
        if (!includeReasoning) break
        const message = openAssistant(event)
        const text = String(event.payload.text ?? '')
        message.reasoning = (message.reasoning ?? '') + text
        break
      }

      case 'tool.call': {
        const message = openAssistant(event)
        const id = String(event.payload.callId ?? event.id)
        message.content.push({
          type: 'tool_use',
          id,
          name: String(event.payload.call ?? ''),
          input: event.payload.args ?? {},
        })
        pending.set(id, message)
        break
      }

      case 'tool.result': {
        const id = String(event.payload.callId ?? event.refs?.toolCall ?? '')
        messages.push({
          role: 'tool',
          toolUseId: id,
          content: String(event.payload.text ?? ''),
          isError: Boolean(event.payload.isError),
          sourceEventId: event.id,
        })
        pending.delete(id)
        fulfilled.add(id)
        currentAssistant = undefined
        break
      }

      default:
        break
    }
  }

  if (options.fillMissingToolResults ?? true) {
    for (const [id] of pending) {
      if (fulfilled.has(id)) continue
      messages.push({
        role: 'tool',
        toolUseId: id,
        content: '（无结果：本轮中断）',
        isError: true,
      })
    }
  }

  return messages
}
