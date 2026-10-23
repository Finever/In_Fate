/**
 * UI 时间线投影：事件 → 可渲染的卡片。
 *
 * 这是给人看的投影，不是模型投影：
 *   - 模型看压缩后的尾部；UI 要看完整时间线
 *   - 全文不在这里展开，只给预览 + ref
 *   - 分页按轮（message.user/system → turn.completed），不切断工具配对
 *
 * @module if/ui/timeline
 */

import type { Event } from '../core/events.ts'
import type { PruneItem, PrunePayload } from '../compaction/types.ts'

export interface UiContent {
  readonly preview: string
  readonly bytes: number
  readonly mime?: string
  readonly encoding?: string
  readonly ref?: string
  readonly truncated: boolean
}

export interface UiToolCard {
  readonly callId: string
  readonly name: string
  readonly argsPreview: string
  readonly argsBytes: number
  readonly result?: UiContent
  readonly resultEventId?: string
  readonly isError: boolean
  readonly status: 'running' | 'ok' | 'error'
  readonly durationMs?: number
}

export type UiItemKind =
  | 'user'
  | 'assistant'
  | 'system'
  | 'thoughts'
  | 'tool'
  | 'compaction'
  | 'turn'

export interface UiTimelineItem {
  readonly id: string
  readonly seq: number
  readonly turn: number
  readonly kind: UiItemKind
  readonly ts: string
  readonly actor?: string
  readonly status?: 'running' | 'ok' | 'error' | 'cancelled' | 'waiting'
  readonly title: string
  readonly content?: UiContent
  readonly tool?: UiToolCard
  readonly compaction?: {
    readonly summary: unknown
    readonly anchor: unknown
    readonly stats: unknown
  }
  readonly turnUsage?: {
    readonly steps: number
    readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
    readonly hitLimit: boolean
  }
}

export interface UiTimelineOptions {
  /** 只返回 startSeq 小于它的轮（向上翻页） */
  readonly before?: number
  /** 只返回 startSeq 大于它的轮（向下翻页） */
  readonly after?: number
  readonly limit?: number
  /** 分页游标绑定的索引代际；不一致说明语料变了 */
  readonly generation?: number
}

export interface UiTimelinePage {
  readonly sessionId: string
  readonly items: readonly UiTimelineItem[]
  readonly turns: number
  readonly hasMoreBefore: boolean
  readonly hasMoreAfter: boolean
  readonly nextBefore?: number
  readonly nextAfter?: number
  /** 这页数据对应的最后一条事件 seq */
  readonly asOfSeq?: number
  /** 索引代际；每次新增/重建都递增 */
  readonly generation?: number
}

interface IndexedEvent {
  readonly event: Event
  readonly index: number
  readonly seq: number
}

interface Turn {
  readonly index: number
  readonly events: readonly IndexedEvent[]
  readonly startSeq: number
  readonly endSeq: number
}

const PREVIEW_CHARS = 800
const ARGS_PREVIEW_CHARS = 400
const DEFAULT_LIMIT = 20

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const headSize = Math.ceil(max * 0.7)
  let head = text.slice(0, headSize)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  let tail = text.slice(-(max - headSize))
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
  return `${head}\n…\n${tail}`
}

function textOf(event: Event): string {
  return String(event.payload.text ?? '')
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function uiContentOf(
  text: string,
  payload: Readonly<Record<string, unknown>>,
  pruned?: PruneItem,
): UiContent {
  const ref = typeof payload.ref === 'string'
    ? payload.ref
    : pruned?.ref
  const contentRef = payload.contentRef as { ref?: unknown } | undefined
  const bytes = typeof payload.bytes === 'number'
    ? payload.bytes
    : pruned?.beforeBytes ?? bytesOf(text)
  const preview = clip(text, PREVIEW_CHARS)
  return {
    preview,
    bytes,
    ...(typeof payload.mime === 'string' ? { mime: payload.mime } : {}),
    ...(typeof payload.encoding === 'string' ? { encoding: payload.encoding } : {}),
    ...(typeof ref === 'string'
      ? { ref }
      : typeof contentRef?.ref === 'string'
        ? { ref: contentRef.ref }
        : {}),
    truncated: preview.length < text.length || typeof ref === 'string' || contentRef !== undefined,
  }
}

export function uiArgsOf(event: Event): { preview: string; bytes: number } {
  try {
    const text = JSON.stringify(event.payload.args ?? {})
    return { preview: clip(text, ARGS_PREVIEW_CHARS), bytes: bytesOf(text) }
  } catch {
    return { preview: '[unserializable args]', bytes: 0 }
  }
}

function seqOf(event: Event, index: number): number {
  return typeof event.seq === 'number' ? event.seq : index
}

function groupUiTurns(events: readonly Event[]): Turn[] {
  const turns: Turn[] = []
  let current: IndexedEvent[] = []

  const push = (): void => {
    if (current.length === 0) return
    turns.push({
      index: turns.length + 1,
      events: current,
      startSeq: current[0]!.seq,
      endSeq: current[current.length - 1]!.seq,
    })
    current = []
  }

  events.forEach((event, index) => {
    if (
      event.type === 'message.user'
      || event.type === 'message.system'
      || event.type === 'session.message'
    ) {
      push()
      current = [{ event, index, seq: seqOf(event, index) }]
      return
    }
    if (current.length === 0) return
    current.push({ event, index, seq: seqOf(event, index) })
    if (event.type === 'turn.completed') push()
  })
  push()

  return turns
}

function pruneMap(events: readonly Event[]): Map<string, PruneItem> {
  const map = new Map<string, PruneItem>()
  for (const event of events) {
    if (event.type !== 'compaction.pruned') continue
    const payload = event.payload as unknown as PrunePayload
    if (Array.isArray(payload.items)) {
      for (const item of payload.items) map.set(item.eventId, item)
      continue
    }
    for (const id of payload.eventIds ?? []) {
      map.set(String(id), {
        eventId: String(id),
        preview: payload.preview ?? '',
        ...(payload.ref ? { ref: payload.ref } : {}),
        beforeBytes: payload.beforeBytes ?? 0,
        afterBytes: payload.afterBytes ?? 0,
      })
    }
  }
  return map
}

function itemsOfTurn(turn: Turn, pruned: Map<string, PruneItem>): UiTimelineItem[] {
  const items: UiTimelineItem[] = []
  const calls = new Map<string, UiTimelineItem>()
  const callTimes = new Map<string, number>()

  for (const { event, seq } of turn.events) {
    const base = {
      id: event.id,
      seq,
      turn: turn.index,
      ts: event.ts,
      ...(event.actorId ? { actor: event.actorId } : {}),
    }

    switch (event.type) {
      case 'message.user':
      case 'message.system': {
        items.push({
          ...base,
          kind: event.type === 'message.user' ? 'user' : 'system',
          title: event.type === 'message.user' ? '你' : '系统',
          content: uiContentOf(textOf(event), event.payload),
        })
        break
      }

      case 'session.message': {
        const from = typeof event.payload.fromSession === 'string'
          ? event.payload.fromSession
          : (event.refs?.fromSession ?? '?')
        items.push({
          ...base,
          kind: 'system',
          title: `跨会话 · ${from}`,
          content: uiContentOf(textOf(event), event.payload),
        })
        break
      }

      case 'message.assistant': {
        items.push({
          ...base,
          kind: 'assistant',
          title: '助手',
          content: uiContentOf(textOf(event), event.payload),
        })
        break
      }

      case 'thoughts.segment': {
        items.push({
          ...base,
          kind: 'thoughts',
          title: '思考',
          content: uiContentOf(textOf(event), event.payload),
        })
        break
      }

      case 'tool.call': {
        const callId = String(event.payload.callId ?? event.id)
        const args = uiArgsOf(event)
        const item: UiTimelineItem = {
          ...base,
          kind: 'tool',
          title: String(event.payload.call ?? '工具'),
          status: 'running',
          tool: {
            callId,
            name: String(event.payload.call ?? '工具'),
            argsPreview: args.preview,
            argsBytes: args.bytes,
            isError: false,
            status: 'running',
          },
        }
        calls.set(callId, item)
        callTimes.set(callId, Date.parse(event.ts))
        items.push(item)
        break
      }

      case 'tool.result': {
        const callId = String(event.payload.callId ?? event.refs?.toolCall ?? '')
        const prunedItem = pruned.get(event.id)
        const text = prunedItem?.preview ?? textOf(event)
        const raw = prunedItem
          ? uiContentOf(text, {
            ...event.payload,
            ...(prunedItem.ref ? { ref: prunedItem.ref } : {}),
            bytes: prunedItem.beforeBytes,
          })
          : uiContentOf(text, event.payload)
        const existing = calls.get(callId)
        if (existing) {
          const started = callTimes.get(callId)
          const finished = Date.parse(event.ts)
          const card: UiToolCard = {
            ...existing.tool!,
            result: raw,
            resultEventId: event.id,
            isError: Boolean(event.payload.isError),
            status: event.payload.isError ? 'error' : 'ok',
            ...(typeof started === 'number' && Number.isFinite(started) && Number.isFinite(finished)
              ? { durationMs: Math.max(0, finished - started) }
              : {}),
          }
          const index = items.indexOf(existing)
          items[index] = {
            ...existing,
            status: card.status,
            tool: card,
          }
        } else {
          items.push({
            ...base,
            kind: 'tool',
            title: '工具结果',
            status: event.payload.isError ? 'error' : 'ok',
            tool: {
              callId,
              name: 'unknown',
              argsPreview: '',
              argsBytes: 0,
              result: raw,
              resultEventId: event.id,
              isError: Boolean(event.payload.isError),
              status: event.payload.isError ? 'error' : 'ok',
            },
          })
        }
        break
      }

      case 'context.compacted': {
        const payload = event.payload as {
          summary?: unknown
          anchor?: unknown
          stats?: unknown
        }
        const summary = payload.summary as { goal?: unknown } | undefined
        const goal = typeof summary?.goal === 'string' ? summary.goal : '已压缩历史'
        items.push({
          ...base,
          kind: 'compaction',
          title: '压缩摘要',
          content: uiContentOf(goal, event.payload),
          compaction: {
            summary: payload.summary,
            anchor: payload.anchor,
            stats: payload.stats,
          },
        })
        break
      }

      case 'turn.completed': {
        const usage = event.payload.usage as {
          input?: number
          output?: number
          cacheRead?: number
        } | undefined
        const waiting = event.payload.status === 'waiting'
        items.push({
          ...base,
          kind: 'turn',
          title: waiting ? '等待中' : '本轮完成',
          status: waiting
            ? 'waiting'
            : event.payload.status === 'failed'
              ? 'error'
              : event.payload.aborted ? 'cancelled' : 'ok',
          turnUsage: {
            steps: Number(event.payload.steps ?? 0),
            usage: {
              input: Number(usage?.input ?? 0),
              output: Number(usage?.output ?? 0),
              cacheRead: Number(usage?.cacheRead ?? 0),
            },
            hitLimit: Boolean(event.payload.hitLimit),
          },
        })
        break
      }

      default:
        break
    }
  }

  return items
}

export function projectUiTimeline(
  sessionId: string,
  events: readonly Event[],
  options: UiTimelineOptions = {},
): UiTimelinePage {
  const limit = Math.max(1, Math.min(200, options.limit ?? DEFAULT_LIMIT))
  const turns = groupUiTurns(events)

  let selected = turns
  if (options.before !== undefined) {
    selected = selected.filter(turn => turn.startSeq < options.before!)
  }
  if (options.after !== undefined) {
    selected = selected.filter(turn => turn.startSeq > options.after!)
  }
  selected = options.after !== undefined ? selected.slice(0, limit) : selected.slice(-limit)

  const first = selected[0]
  const last = selected.at(-1)
  const pruned = pruneMap(events)
  const items = selected.flatMap(turn => itemsOfTurn(turn, pruned))

  return {
    sessionId,
    items,
    turns: selected.length,
    hasMoreBefore: first
      ? turns.some(turn => turn.startSeq < first.startSeq)
      : false,
    hasMoreAfter: last
      ? turns.some(turn => turn.startSeq > last.startSeq)
      : false,
    ...(first ? { nextBefore: first.startSeq } : {}),
    ...(last ? { nextAfter: last.endSeq } : {}),
  }
}

export const UI_PREVIEW_CHARS = PREVIEW_CHARS
