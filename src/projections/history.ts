/**
 * 会话历史投影：事件流 → 模型无关的消息数组。
 *
 * 纯函数。不读当前时间、不裁剪、不摘要。绝对时间只放在消息前，
 * 工具与思考只带耗时（由事件 payload 给），不写进文本。
 * 悬空 tool_use 补一条中断结果——否则模型 API 会拒收。
 *
 * @module if/projections/history
 */

import { buildCompactionIndex } from '../compaction/project.ts'
import type { CompactionPayload } from '../compaction/types.ts'
import { markSystem } from '../context/marks.ts'
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
  reasoning?: string
  /** 消息来自哪条事件，审计用；渲染给模型前去掉 */
  readonly sourceEventId?: string
  /** 定时任务推来的 system 消息标 scheduled；压缩摘要标 compaction */
  readonly origin?: 'user' | 'scheduled' | 'agent' | 'compaction'
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

/** `YYYY-MM-DD HH:mm`，用于和模型复制的标签比对。 */
function localStamp(ts: string, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts))
}

function minutesOf(stamp: string): number {
  const [date, time] = stamp.split(' ')
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return Date.UTC(year, month - 1, day, hour, minute) / 60_000
}

/**
 * 模型会模仿消息前的时间标签。只去掉“与本条消息时间相差 ≤2 分钟、
 * 且恰好在开头”的那一个；事件原文不动，投影时清洗。
 */
function stripEchoedTimeTag(text: string, ts: string, timeZone: string): string {
  const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*/.exec(text)
  if (!match) return text
  const echoed = minutesOf(match[1])
  const actual = minutesOf(localStamp(ts, timeZone))
  if (!Number.isFinite(echoed) || Math.abs(echoed - actual) > 2) return text
  return text.slice(match[0].length)
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
  const compaction = buildCompactionIndex(events)
  let rangeCursor = 0
  let skipUntil = -1

  const tag = (event: Event): string => (addTime ? formatTimeTag(event.ts, timeZone) : '')

  const openAssistant = (event: Event): ChatMessage => {
    if (currentAssistant) return currentAssistant
    currentAssistant = { role: 'assistant', content: [], sourceEventId: event.id }
    messages.push(currentAssistant)
    return currentAssistant
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]

    // 压缩区间：在起点插一条摘要，区间内的事件全部跳过。
    while (
      rangeCursor < compaction.ranges.length
      && eventIndex === compaction.ranges[rangeCursor].start
    ) {
      const range = compaction.ranges[rangeCursor]
      messages.push(compactionMessage(range.payload))
      skipUntil = Math.max(skipUntil, range.end)
      rangeCursor += 1
    }
    if (eventIndex <= skipUntil) continue

    switch (event.type) {
      case 'message.user':
      case 'message.system': {
        currentAssistant = undefined
        const scheduled = event.type === 'message.system'
        const body = tag(event) + textOf(event)
        // 系统消息可以自带分类；没写就按定时任务处理。
        const mark = event.payload.mark
        const kind = mark === 'compaction' || mark === 'scheduled'
          || mark === 'injection' || mark === 'time'
          ? mark
          : 'scheduled'
        messages.push({
          role: scheduled ? 'system' : 'user',
          content: [{ type: 'text', text: scheduled ? markSystem(kind, body) : body }],
          sourceEventId: event.id,
          origin: scheduled ? 'scheduled' : 'user',
        })
        break
      }

      case 'message.assistant': {
        const message = openAssistant(event)
        const body = stripEchoedTimeTag(textOf(event), event.ts, timeZone)
        message.content.push({ type: 'text', text: tag(event) + body })
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
        const prune = compaction.pruned.get(event.id)
        const content = prune
          ? `${prune.preview}\n…[pruned, ${prune.beforeBytes} bytes${prune.ref ? ` at ${prune.ref}` : ''}]`
          : String(event.payload.text ?? '')
        messages.push({
          role: 'tool',
          toolUseId: id,
          content,
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

/** 压缩摘要渲染成一条明确的系统消息，带锚点。 */
function compactionMessage(payload: CompactionPayload): ChatMessage {
  const summary = payload.summary
  const lines = [
    `目标：${summary.goal}`,
    summary.constraints.length > 0 ? `约束：${summary.constraints.join('；')}` : '',
    summary.decisions.length > 0
      ? `决定：${summary.decisions.map(item => item.what + (item.why ? `（${item.why}）` : '')).join('；')}`
      : '',
    summary.facts.length > 0 ? `事实：${summary.facts.join('；')}` : '',
    summary.failed.length > 0
      ? `失败：${summary.failed.map(item => `${item.tried}—${item.why_failed}`).join('；')}`
      : '',
    summary.open.length > 0 ? `未完成：${summary.open.join('；')}` : '',
  ].filter(line => line.length > 0)

  return {
    role: 'system',
    content: [{
      type: 'text',
      text: markSystem('compaction', lines.join('\n'), {
        stream: payload.anchor.stream,
        from: payload.anchor.fromEventId,
        to: payload.anchor.toEventId,
      }),
    }],
    origin: 'compaction',
  }
}
