import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Event } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import {
  appendLog,
  ensureMeta,
  hintFromArgs,
  localLogStamp,
  logPathForDay,
  nextTurn,
  readLog,
  type LogMeta,
  type LogRow,
} from './log.ts'

export interface MemoryLogSessionMeta {
  readonly agentId?: string
  readonly agentName?: string
  readonly cwd?: string
}

export interface MemoryLogServiceOptions {
  readonly memoryRoot: string
  readonly timeZone: string
  readonly userName: string
  readonly metaFor: (sessionId: string) => MemoryLogSessionMeta
  readonly onError?: (error: unknown) => void
}

interface CursorState {
  readonly cursor: string
  readonly updatedAt: string
}

const INTERESTING = new Set([
  'message.user',
  'message.assistant',
  'tool.call',
  'turn.completed',
])

function textOf(event: Event): string {
  const value = event.payload.text
  return typeof value === 'string' ? value : String(value ?? '')
}

function eventTime(event: Event): Date {
  const date = new Date(event.ts)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

export class MemoryLogService {
  readonly root: string
  private readonly timeZone: string
  private readonly userName: string
  private readonly metaFor: (sessionId: string) => MemoryLogSessionMeta
  private readonly onError?: (error: unknown) => void
  private readonly statePath: string
  private readonly cursors = new Map<string, string>()
  private readonly stores = new Map<string, EventStore>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly sourceCache = new Map<string, Set<string>>()

  constructor(options: MemoryLogServiceOptions) {
    this.root = options.memoryRoot
    this.timeZone = options.timeZone
    this.userName = options.userName
    this.metaFor = options.metaFor
    this.onError = options.onError
    this.statePath = join(this.root, '.state', 'log-cursors.json')
    this.loadState()
  }

  /** 会话 store 第一次出现时挂上；已有历史会异步补齐。 */
  attach(sessionId: string, store: EventStore): void {
    if (this.stores.has(sessionId)) return
    this.stores.set(sessionId, store)
    store.subscribe(event => this.onEvent(sessionId, event))
    this.enqueue(sessionId)
  }

  /** SessionWriter 每追加一条事件后调用；只处理会影响流水的类型。 */
  onEvent(sessionId: string, event: Event): void {
    if (!INTERESTING.has(event.type)) return
    this.enqueue(sessionId)
  }

  /** 测试/关闭前用；等待所有排队补齐。 */
  async flush(): Promise<void> {
    while (this.queues.size > 0) {
      const pending = [...this.queues.values()]
      await Promise.all(pending.map(task => task.catch(() => undefined)))
    }
  }

  private enqueue(sessionId: string): void {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() => this.catchUp(sessionId))
      .catch(error => {
        this.onError?.(error)
      })
    this.queues.set(sessionId, task)
    void task.finally(() => {
      if (this.queues.get(sessionId) === task) this.queues.delete(sessionId)
    })
  }

  private async catchUp(sessionId: string): Promise<void> {
    const store = this.stores.get(sessionId)
    if (!store) return

    const cursor = this.cursors.get(sessionId)
    let events: readonly Event[]
    if (cursor) {
      try {
        events = store.readSince(cursor)
      } catch {
        // 游标所在段被归档/删掉时退回全量；src 去重会兜住重复。
        events = store.readAll()
      }
    } else {
      events = store.readAll()
    }
    if (events.length === 0) return

    let pending: LogRow[] = []
    let pendingSeen = new Set<string>()
    let lastTurnEnd: string | undefined

    for (const event of events) {
      switch (event.type) {
        case 'message.user': {
          this.writeUser(sessionId, event)
          pending = []
          pendingSeen = new Set()
          break
        }
        case 'message.assistant': {
          if (pendingSeen.has(event.id)) break
          const text = textOf(event)
          if (text.trim().length === 0) break
          pendingSeen.add(event.id)
          pending.push({ type: 'text', p: text, src: event.id })
          break
        }
        case 'tool.call': {
          if (pendingSeen.has(event.id)) break
          pendingSeen.add(event.id)
          const args = event.payload.args ?? {}
          pending.push({
            type: 'tool',
            call: String(event.payload.call ?? ''),
            hint: hintFromArgs(args),
            args,
            src: event.id,
          })
          break
        }
        case 'turn.completed': {
          this.writeAssistantTurn(sessionId, event, pending)
          pending = []
          pendingSeen = new Set()
          lastTurnEnd = event.id
          break
        }
        default:
          break
      }
    }

    if (lastTurnEnd && lastTurnEnd !== cursor) {
      this.cursors.set(sessionId, lastTurnEnd)
      this.persistState()
    }
  }

  private stamp(event: Event): ReturnType<typeof localLogStamp> {
    return localLogStamp(eventTime(event), this.timeZone)
  }

  private fileFor(sessionId: string, event: Event): {
    path: string
    stamp: ReturnType<typeof localLogStamp>
  } {
    const stamp = this.stamp(event)
    return { path: logPathForDay(this.root, stamp, sessionId), stamp }
  }

  private ensureFileMeta(sessionId: string, path: string, stamp: ReturnType<typeof localLogStamp>): void {
    const session = this.metaFor(sessionId)
    const meta: LogMeta = {
      _meta: 1,
      agentid: session.agentId ?? '',
      agent_name: session.agentName ?? session.agentId ?? '',
      session: sessionId,
      date: stamp.day,
      cwd: session.cwd ?? '',
      start: stamp.time,
    }
    ensureMeta(path, meta)
  }

  private sourcesOf(path: string): Set<string> {
    const cached = this.sourceCache.get(path)
    if (cached) return cached
    const sources = new Set<string>()
    if (existsSync(path)) {
      for (const row of readLog(path, { skipBadLines: true })) {
        if (typeof row.src === 'string') sources.add(row.src)
      }
    }
    this.sourceCache.set(path, sources)
    return sources
  }

  private writeUser(sessionId: string, event: Event): void {
    const { path, stamp } = this.fileFor(sessionId, event)
    this.ensureFileMeta(sessionId, path, stamp)
    const sources = this.sourcesOf(path)
    if (sources.has(event.id)) return
    const rows = readLog(path, { skipBadLines: true })
    const n = nextTurn(rows)
    appendLog(path, [{
      n,
      who: this.userName,
      ts: stamp.time,
      text: textOf(event),
      src: event.id,
    }])
    sources.add(event.id)
  }

  private writeAssistantTurn(
    sessionId: string,
    event: Event,
    blocks: readonly LogRow[],
  ): void {
    if (blocks.length === 0) return
    const { path, stamp } = this.fileFor(sessionId, event)
    this.ensureFileMeta(sessionId, path, stamp)
    const sources = this.sourcesOf(path)
    if (sources.has(event.id)) return

    const session = this.metaFor(sessionId)
    const rows = readLog(path, { skipBadLines: true })
    const n = nextTurn(rows)
    const out: LogRow[] = [{
      n,
      who: session.agentName ?? session.agentId ?? 'agent',
      type: 'turn-start',
      ts: stamp.time,
      src: event.id,
    }]
    for (const block of blocks) out.push({ ...block, n })
    out.push({ n, type: 'turn-end', ts: stamp.time })
    appendLog(path, out)
    sources.add(event.id)
  }

  private loadState(): void {
    if (!existsSync(this.statePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, unknown>
      for (const [sessionId, value] of Object.entries(raw)) {
        if (typeof value === 'string') {
          this.cursors.set(sessionId, value)
        } else if (
          typeof value === 'object'
          && value !== null
          && typeof (value as CursorState).cursor === 'string'
        ) {
          this.cursors.set(sessionId, (value as CursorState).cursor)
        }
      }
    } catch {
      // 游标坏了就退回全量重放；log 行有 src 去重。
    }
  }

  private persistState(): void {
    mkdirSync(join(this.root, '.state'), { recursive: true })
    const doc: Record<string, CursorState> = {}
    for (const [sessionId, cursor] of this.cursors) {
      doc[sessionId] = { cursor, updatedAt: new Date().toISOString() }
    }
    const temp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    renameSync(temp, this.statePath)
  }
}
