/**
 * UI 元数据索引（SQLite）。
 *
 * 事件日志仍是唯一真相；这里只存“渲染需要的卡片快照”，
 * 用于按轮分页，避免每次翻页都 read() 全量事件。索引可重建。
 *
 * @module if/ui/index
 */

import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Event } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import type { PruneItem, PrunePayload } from '../compaction/types.ts'
import type { UiSessionStats } from './api.ts'
import {
  uiArgsOf,
  uiContentOf,
  type UiTimelineItem,
  type UiTimelineOptions,
  type UiTimelinePage,
  type UiToolCard,
} from './timeline.ts'

const SCHEMA_VERSION = '1'
const DEFAULT_LIMIT = 20

export class UiIndexStaleError extends Error {
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super(`ui index generation changed: ${expected} -> ${actual}`)
    this.name = 'UiIndexStaleError'
    this.expected = expected
    this.actual = actual
  }
}

export interface UiTurnMeta {
  readonly turn: number
  readonly startSeq: number
  readonly endSeq: number
  readonly itemCount: number
}

interface TurnRow {
  readonly turn: number
  readonly start_seq: number
  readonly end_seq: number
}

interface ItemRow {
  readonly seq: number
  readonly turn: number
  readonly item_json: string
}

function clampLimit(value: number | undefined): number {
  return Math.max(1, Math.min(200, value ?? DEFAULT_LIMIT))
}

export class UiIndex {
  readonly file: string
  private readonly db: DatabaseSync
  private currentTurn = 0
  private eventCount = 0
  private prunedCount = 0
  private generation = 0
  private closedFlag = false
  private readonly pruned = new Map<string, PruneItem>()

  private constructor(file: string) {
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    // UI 索引只由本进程读写；用回滚日志，退出时 Windows 能干净删掉文件。
    this.db.exec('PRAGMA journal_mode = DELETE')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_turns (
        turn INTEGER PRIMARY KEY,
        start_seq INTEGER NOT NULL,
        end_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ui_items (
        seq INTEGER PRIMARY KEY,
        turn INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ts TEXT NOT NULL,
        id TEXT NOT NULL,
        tool_call_id TEXT,
        result_event_id TEXT,
        item_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ui_items_turn ON ui_items(turn, seq);
    `)

    const version = this.meta('schema_version')
    if (version !== SCHEMA_VERSION) {
      this.resetTables()
      this.setMeta('schema_version', SCHEMA_VERSION)
    }

    this.currentTurn = Number(this.meta('current_turn') ?? '0')
    this.eventCount = Number(this.meta('event_count') ?? '0')
    this.prunedCount = Number(this.meta('pruned_count') ?? '0')
    this.generation = Number(this.meta('generation') ?? '0')
  }

  static open(file: string): UiIndex {
    return new UiIndex(file)
  }

  sync(store: EventStore): void {
    if (this.closedFlag) throw new Error('ui index closed')

    const segments = store.segments()
    let bytes = 0
    for (const segment of segments) {
      try {
        bytes += statSync(segment).size
      } catch {
        // 段可能刚轮转
      }
    }

    const lastEventId = this.meta('last_event_id')
    const sameBytes = this.meta('last_bytes') === String(bytes)
    const sameSegments = this.meta('last_segments') === String(segments.length)
    if (lastEventId && sameBytes && sameSegments) return

    let events: readonly Event[]
    let rebuild = false
    if (!lastEventId) {
      events = store.read()
      rebuild = true
    } else {
      try {
        events = store.readSince(lastEventId)
      } catch {
        events = store.read()
        rebuild = true
      }
    }

    if (rebuild) {
      this.generation = Number(this.meta('generation') ?? String(this.generation)) + 1
      this.resetTables()
      this.setMeta('schema_version', SCHEMA_VERSION)
      this.setMeta('generation', String(this.generation))
      this.pruned.clear()
      this.currentTurn = 0
      this.eventCount = 0
      this.prunedCount = 0
    } else if (events.length > 0) {
      this.generation += 1
    }

    let seqCursor = Number(this.meta('last_seq') ?? '-1') + 1
    this.db.exec('BEGIN')
    try {
      for (const event of events) {
        this.appendOne(event, seqCursor)
        seqCursor = typeof event.seq === 'number' ? event.seq + 1 : seqCursor + 1
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const last = events.at(-1)
    this.setMeta('last_bytes', String(bytes))
    this.setMeta('last_segments', String(segments.length))
    this.setMeta('current_turn', String(this.currentTurn))
    this.setMeta('event_count', String(this.eventCount))
    this.setMeta('pruned_count', String(this.prunedCount))
    this.setMeta('generation', String(this.generation))
    if (last) {
      this.setMeta('last_event_id', last.id)
      this.setMeta('last_seq', String(seqCursor - 1))
    } else if (rebuild) {
      this.setMeta('last_event_id', '')
      this.setMeta('last_seq', '-1')
    }
  }

  page(sessionId: string, options: UiTimelineOptions = {}): UiTimelinePage {
    if (this.closedFlag) throw new Error('ui index closed')
    const generation = Number(this.meta('generation') ?? String(this.generation))
    if (options.generation !== undefined && options.generation !== generation) {
      throw new UiIndexStaleError(options.generation, generation)
    }
    const limit = clampLimit(options.limit)

    let rows: TurnRow[]
    if (options.before !== undefined) {
      rows = this.db.prepare(
        'SELECT turn, start_seq, end_seq FROM ui_turns WHERE start_seq < ? ORDER BY turn DESC LIMIT ?',
      ).all(options.before, limit) as unknown as TurnRow[]
      rows.reverse()
    } else if (options.after !== undefined) {
      rows = this.db.prepare(
        'SELECT turn, start_seq, end_seq FROM ui_turns WHERE start_seq > ? ORDER BY turn ASC LIMIT ?',
      ).all(options.after, limit) as unknown as TurnRow[]
    } else {
      rows = this.db.prepare(
        'SELECT turn, start_seq, end_seq FROM ui_turns ORDER BY turn DESC LIMIT ?',
      ).all(limit) as unknown as TurnRow[]
      rows.reverse()
    }

    const first = rows[0]
    const last = rows.at(-1)
    const items = first && last
      ? (this.db.prepare(
        'SELECT seq, turn, item_json FROM ui_items WHERE turn BETWEEN ? AND ? ORDER BY seq',
      ).all(first.turn, last.turn) as unknown as ItemRow[])
        .map(row => JSON.parse(row.item_json) as UiTimelineItem)
      : []

    const hasMoreBefore = first
      ? Boolean(this.db.prepare('SELECT 1 FROM ui_turns WHERE start_seq < ? LIMIT 1').get(first.start_seq))
      : false
    const hasMoreAfter = last
      ? Boolean(this.db.prepare('SELECT 1 FROM ui_turns WHERE end_seq > ? LIMIT 1').get(last.end_seq))
      : false

    return {
      sessionId,
      items,
      turns: rows.length,
      hasMoreBefore,
      hasMoreAfter,
      ...(first ? { nextBefore: first.start_seq } : {}),
      ...(last ? { nextAfter: last.end_seq } : {}),
      asOfSeq: Number(this.meta('last_seq') ?? '-1'),
      generation,
    }
  }

  turns(): UiTurnMeta[] {
    if (this.closedFlag) throw new Error('ui index closed')
    const rows = this.db.prepare(`
      SELECT t.turn, t.start_seq, t.end_seq, COUNT(i.seq) AS n
      FROM ui_turns t
      LEFT JOIN ui_items i ON i.turn = t.turn
      GROUP BY t.turn, t.start_seq, t.end_seq
      ORDER BY t.turn ASC
    `).all() as unknown as {
      turn: number
      start_seq: number
      end_seq: number
      n: number
    }[]

    return rows.map(row => ({
      turn: Number(row.turn),
      startSeq: Number(row.start_seq),
      endSeq: Number(row.end_seq),
      itemCount: Number(row.n),
    }))
  }

  itemsOfTurn(turn: number): UiTimelineItem[] {
    if (this.closedFlag) throw new Error('ui index closed')
    return (this.db.prepare(
      'SELECT item_json FROM ui_items WHERE turn = ? ORDER BY seq',
    ).all(turn) as unknown as { item_json: string }[])
      .map(row => JSON.parse(row.item_json) as UiTimelineItem)
  }

  stats(sessionId: string, store: EventStore): UiSessionStats {
    if (this.closedFlag) throw new Error('ui index closed')
    let fileBytes = 0
    const segments = store.segments()
    for (const segment of segments) {
      try {
        fileBytes += statSync(segment).size
      } catch {
        // 段可能刚轮转
      }
    }

    const turnRow = this.db.prepare('SELECT COUNT(*) AS n FROM ui_turns').get() as { n: number }
    const compactedRow = this.db.prepare(
      "SELECT COUNT(*) AS n FROM ui_items WHERE kind = 'compaction'",
    ).get() as { n: number }

    return {
      sessionId,
      events: this.eventCount,
      turns: Number(turnRow.n),
      compacted: Number(compactedRow.n),
      pruned: this.prunedCount,
      lastSeq: Number(this.meta('last_seq') ?? '-1'),
      asOfSeq: Number(this.meta('last_seq') ?? '-1'),
      fileBytes,
      segments: segments.length,
    }
  }

  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    try {
      this.db.close()
    } catch {
      // 已关闭
    }
  }

  private appendOne(event: Event, fallbackSeq: number): void {
    const seq = typeof event.seq === 'number' ? event.seq : fallbackSeq
    this.eventCount += 1

    if (event.type === 'session.created') return

    // prune 可能发生在没有活跃轮的压缩阶段；它只更新已有结果，不依赖轮号。
    if (event.type === 'compaction.pruned') {
      const payload = event.payload as unknown as PrunePayload
      const items = Array.isArray(payload.items)
        ? payload.items
        : (payload.eventIds ?? []).map(id => ({
          eventId: String(id),
          preview: payload.preview ?? '',
          ...(payload.ref ? { ref: payload.ref } : {}),
          beforeBytes: payload.beforeBytes ?? 0,
          afterBytes: payload.afterBytes ?? 0,
        }))
      for (const item of items) {
        this.pruned.set(item.eventId, item)
        this.prunedCount += 1
        this.applyPrune(item)
      }
      return
    }

    if (event.type === 'message.user' || event.type === 'message.system') {
      this.currentTurn = this.maxTurn() + 1
      this.db.prepare(
        'INSERT OR REPLACE INTO ui_turns(turn, start_seq, end_seq) VALUES(?,?,?)',
      ).run(this.currentTurn, seq, seq)
    }

    if (this.currentTurn === 0) {
      // 手动压缩等无用户消息的事件：建一个独立卡片轮，但不占用下一轮编号。
      if (event.type === 'context.compacted') {
        const turn = this.maxTurn() + 1
        this.db.prepare(
          'INSERT OR REPLACE INTO ui_turns(turn, start_seq, end_seq) VALUES(?,?,?)',
        ).run(turn, seq, seq)
        this.insertItem(this.itemFor(event, turn, seq))
      }
      return
    }

    this.db.prepare('UPDATE ui_turns SET end_seq = ? WHERE turn = ?').run(seq, this.currentTurn)

    switch (event.type) {
      case 'message.user':
      case 'message.system':
      case 'message.assistant':
      case 'thoughts.segment':
        this.insertItem(this.itemFor(event, this.currentTurn, seq))
        break

      case 'tool.call': {
        const callId = String(event.payload.callId ?? event.id)
        const args = uiArgsOf(event)
        const item: UiTimelineItem = {
          id: event.id,
          seq,
          turn: this.currentTurn,
          kind: 'tool',
          ts: event.ts,
          ...(event.actorId ? { actor: event.actorId } : {}),
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
        this.insertItem(item, callId)
        break
      }

      case 'tool.result': {
        const callId = String(event.payload.callId ?? event.refs?.toolCall ?? '')
        const prunedItem = this.pruned.get(event.id)
        const text = prunedItem?.preview ?? String(event.payload.text ?? '')
        const content = prunedItem
          ? uiContentOf(text, {
            ...event.payload,
            ...(prunedItem.ref ? { ref: prunedItem.ref } : {}),
            bytes: prunedItem.beforeBytes,
          })
          : uiContentOf(text, event.payload)

        const row = this.db.prepare(
          'SELECT seq, item_json FROM ui_items WHERE tool_call_id = ? AND result_event_id IS NULL ORDER BY seq DESC LIMIT 1',
        ).get(callId) as { seq: number; item_json: string } | undefined

        if (row) {
          const item = JSON.parse(row.item_json) as UiTimelineItem
          const started = Date.parse(item.ts)
          const finished = Date.parse(event.ts)
          const card: UiToolCard = {
            ...item.tool!,
            result: content,
            resultEventId: event.id,
            isError: Boolean(event.payload.isError),
            status: event.payload.isError ? 'error' : 'ok',
            ...(Number.isFinite(started) && Number.isFinite(finished)
              ? { durationMs: Math.max(0, finished - started) }
              : {}),
          }
          this.updateItem(row.seq, {
            ...item,
            status: card.status,
            tool: card,
          }, callId, event.id)
        } else {
          const item: UiTimelineItem = {
            id: event.id,
            seq,
            turn: this.currentTurn,
            kind: 'tool',
            ts: event.ts,
            ...(event.actorId ? { actor: event.actorId } : {}),
            title: '工具结果',
            status: event.payload.isError ? 'error' : 'ok',
            tool: {
              callId,
              name: 'unknown',
              argsPreview: '',
              argsBytes: 0,
              result: content,
              resultEventId: event.id,
              isError: Boolean(event.payload.isError),
              status: event.payload.isError ? 'error' : 'ok',
            },
          }
          this.insertItem(item, callId, event.id)
        }
        break
      }

      case 'context.compacted': {
        this.insertItem(this.itemFor(event, this.currentTurn, seq))
        break
      }

      case 'turn.completed': {
        this.insertItem(this.itemFor(event, this.currentTurn, seq))
        this.currentTurn = 0
        break
      }

      default:
        break
    }
  }

  private itemFor(event: Event, turn: number, seq: number): UiTimelineItem {
    const base = {
      id: event.id,
      seq,
      turn,
      ts: event.ts,
      ...(event.actorId ? { actor: event.actorId } : {}),
    }

    switch (event.type) {
      case 'message.user':
        return { ...base, kind: 'user', title: '你', content: uiContentOf(String(event.payload.text ?? ''), event.payload) }
      case 'message.system':
        return { ...base, kind: 'system', title: '系统', content: uiContentOf(String(event.payload.text ?? ''), event.payload) }
      case 'message.assistant':
        return { ...base, kind: 'assistant', title: '助手', content: uiContentOf(String(event.payload.text ?? ''), event.payload) }
      case 'thoughts.segment':
        return { ...base, kind: 'thoughts', title: '思考', content: uiContentOf(String(event.payload.text ?? ''), event.payload) }
      case 'context.compacted': {
        const payload = event.payload as { summary?: unknown; anchor?: unknown; stats?: unknown }
        const summary = payload.summary as { goal?: unknown } | undefined
        const goal = typeof summary?.goal === 'string' ? summary.goal : '已压缩历史'
        return {
          ...base,
          kind: 'compaction',
          title: '压缩摘要',
          content: uiContentOf(goal, event.payload),
          compaction: {
            summary: payload.summary,
            anchor: payload.anchor,
            stats: payload.stats,
          },
        }
      }
      case 'turn.completed': {
        const usage = event.payload.usage as { input?: number; output?: number; cacheRead?: number } | undefined
        return {
          ...base,
          kind: 'turn',
          title: '本轮完成',
          status: event.payload.aborted ? 'cancelled' : 'ok',
          turnUsage: {
            steps: Number(event.payload.steps ?? 0),
            usage: {
              input: Number(usage?.input ?? 0),
              output: Number(usage?.output ?? 0),
              cacheRead: Number(usage?.cacheRead ?? 0),
            },
            hitLimit: Boolean(event.payload.hitLimit),
          },
        }
      }
      default:
        return { ...base, kind: 'system', title: event.type }
    }
  }

  private insertItem(item: UiTimelineItem, toolCallId?: string, resultEventId?: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO ui_items(seq, turn, kind, ts, id, tool_call_id, result_event_id, item_json) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      item.seq,
      item.turn,
      item.kind,
      item.ts,
      item.id,
      toolCallId ?? null,
      resultEventId ?? null,
      JSON.stringify(item),
    )
  }

  private updateItem(seq: number, item: UiTimelineItem, toolCallId: string, resultEventId: string): void {
    this.db.prepare(
      'UPDATE ui_items SET item_json = ?, tool_call_id = ?, result_event_id = ? WHERE seq = ?',
    ).run(JSON.stringify(item), toolCallId, resultEventId, seq)
  }

  private applyPrune(item: PruneItem): void {
    const row = this.db.prepare(
      'SELECT seq, item_json FROM ui_items WHERE result_event_id = ? OR id = ? ORDER BY seq DESC LIMIT 1',
    ).get(item.eventId, item.eventId) as { seq: number; item_json: string } | undefined
    if (!row) return

    const existing = JSON.parse(row.item_json) as UiTimelineItem
    if (existing.kind !== 'tool' || !existing.tool?.result) return
    const content = uiContentOf(item.preview, {
      ...(item.ref ? { ref: item.ref } : {}),
      bytes: item.beforeBytes,
    }, item)
    this.db.prepare('UPDATE ui_items SET item_json = ? WHERE seq = ?').run(
      JSON.stringify({
        ...existing,
        tool: { ...existing.tool, result: content },
      }),
      row.seq,
    )
  }

  private maxTurn(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(turn), 0) AS n FROM ui_turns').get() as { n: number }
    return Number(row.n)
  }

  private resetTables(): void {
    this.db.exec('DELETE FROM ui_items; DELETE FROM ui_turns; DELETE FROM meta')
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined
    return row?.v
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    ).run(key, value)
  }
}
