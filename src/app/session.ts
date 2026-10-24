/**
 * 会话目录：一个会话一个事件文件。
 *
 * 只认 `sessions/<id>.jsonl`；分段文件 `<id>.jsonl.1` 属于原会话。
 *
 * @module if/app/session
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Event } from '../core/events.ts'
import { assertSafeSessionId } from '../core/safe-path.ts'
import type { SessionLifecycleState } from '../session/lifecycle.ts'

export interface SessionOrigin {
  readonly sessionId: string
  readonly eventId?: string
}

export type SessionState = 'idle' | 'running' | 'waiting' | 'done' | 'unknown'

export interface SessionInfo {
  readonly id: string
  readonly file: string
  readonly bytes: number
  readonly updatedAt: string
  /** user 或 agent:<preset>；只是溯源，不是权限。 */
  readonly createdBy?: string
  readonly createdFrom?: SessionOrigin
  readonly reason?: string
  readonly kind?: 'user' | 'agent'
  /** 生命周期投影；没有 lifecycle 事件时是 active */
  readonly lifecycle: SessionLifecycleState
  /** 只在 withState 时计算；尾读最后一条，不解析全量 */
  readonly state?: SessionState
  readonly lastActivity?: string
  /** 只在 withTitle 时计算；取首条用户消息，截断后作为列表标题 */
  readonly title?: string
}

export function sessionsDir(dataRoot: string): string {
  return join(dataRoot, 'sessions')
}

export function sessionFile(dataRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId)
  return join(sessionsDir(dataRoot), `${sessionId}.jsonl`)
}

/** UI 元数据索引；不是事件真相，坏了可以重建。 */
export function uiIndexFile(dataRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId)
  return join(dataRoot, 'ui', `${sessionId}.sqlite`)
}

const SESSION_FILE = /^(.+)\.jsonl$/

/** 只读文件头，避免为了取 createdBy 把整份会话读进内存。 */
function firstLine(file: string, maxBytes = 16 * 1024): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    const end = text.indexOf('\n')
    return end >= 0 ? text.slice(0, end) : text
  } finally {
    closeSync(fd)
  }
}

interface SessionOriginInfo {
  createdBy?: string
  createdFrom?: SessionOrigin
  reason?: string
  kind: 'user' | 'agent'
}

function readOrigin(file: string, name: string): SessionOriginInfo {
  const fallback: SessionOriginInfo = {
    kind: name.startsWith('agent-') ? 'agent' : 'user',
  }
  try {
    const event = JSON.parse(firstLine(file)) as {
      type?: string
      payload?: Record<string, unknown>
    }
    if (event.type !== 'session.created') return { ...fallback, kind: 'user' }
    const payload = event.payload ?? {}
    const createdBy = typeof payload.createdBy === 'string' ? payload.createdBy : undefined
    const createdFromRaw = payload.createdFrom
    const createdFrom = typeof createdFromRaw === 'object' && createdFromRaw !== null
      ? (() => {
        const value = createdFromRaw as { sessionId?: unknown; eventId?: unknown }
        if (typeof value.sessionId !== 'string') return undefined
        return {
          sessionId: value.sessionId,
          ...(typeof value.eventId === 'string' ? { eventId: value.eventId } : {}),
        }
      })()
      : undefined
    return {
      ...(createdBy ? { createdBy } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      kind: createdBy === 'agent' || createdBy?.startsWith('agent:') || name.startsWith('agent-')
        ? 'agent'
        : 'user',
    }
  } catch {
    return fallback
  }
}

interface TailEvent {
  readonly type: string
  readonly ts?: string
  readonly payload?: Record<string, unknown>
}

const TERMINAL_AGENT_EVENTS = new Set([
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'agent.interrupted',
])

export interface SessionTailRead {
  readonly events: Event[]
  /** 新日志有 seq：lastSeq + 1；旧日志只能退回尾段条数 */
  readonly total: number
  readonly truncated: boolean
}

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, buffer.length, start)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const TITLE_MAX_CHARS = 80
const TITLE_HEAD_MAX_BYTES = 1024 * 1024

interface SessionTitleCacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly title?: string
}

/** 列表轮询用：文件没变就只 stat，不重复扫头部。 */
const sessionTitleCache = new Map<string, SessionTitleCacheEntry>()

function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateTitle(text: string): string {
  const chars = Array.from(text)
  return chars.length <= TITLE_MAX_CHARS ? text : chars.slice(0, TITLE_MAX_CHARS).join('')
}

/**
 * 从会话开头取首条用户消息作为标题。只读头部，按 mtime/size 缓存；
 * 会话没有用户消息（新建未发言）时返回 undefined，由 UI 显示“新会话”。
 */
export function sessionTitle(file: string): string | undefined {
  const stat = statSync(file)
  const cached = sessionTitleCache.get(file)
  if (cached) {
    if (cached.title !== undefined && stat.size >= cached.size) return cached.title
    if (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.title
  }

  let title: string | undefined
  let budget = Math.min(64 * 1024, Math.max(1, stat.size))
  for (;;) {
    const text = readSlice(file, 0, Math.min(stat.size, budget))
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed) as {
          type?: string
          payload?: { text?: unknown }
        }
        if (event.type !== 'message.user' || typeof event.payload?.text !== 'string') continue
        const normalized = normalizeTitle(event.payload.text)
        if (normalized) {
          title = truncateTitle(normalized)
          break
        }
      } catch {
        // 最后半行可能正在写；找不到就扩大窗口继续
      }
    }
    if (title || budget >= stat.size || budget >= TITLE_HEAD_MAX_BYTES) break
    budget = Math.min(TITLE_HEAD_MAX_BYTES, budget * 4)
  }

  sessionTitleCache.set(file, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ...(title ? { title } : {}),
  })
  if (sessionTitleCache.size > 512) {
    const oldest = sessionTitleCache.keys().next().value
    if (oldest !== undefined) sessionTitleCache.delete(oldest)
  }
  return title
}

/**
 * 只读最后一段字节，返回可解析的完整事件。给 inspect 用，避免每次轮询
 * 重新解析整个活跃段（活跃段可能有几 MB）。如果尾段恰好落在一行大事件
 * 中间，就向前扩，直到拿到至少一条完整事件。
 */
export function readSessionTail(file: string, maxBytes = 256 * 1024): SessionTailRead {
  if (!existsSync(file)) return { events: [], total: 0, truncated: false }
  const stat = statSync(file)
  if (stat.size === 0) return { events: [], total: 0, truncated: false }

  let budget = Math.max(1024, maxBytes)
  let start = 0
  let text = ''
  let events: Event[] = []

  for (;;) {
    start = Math.max(0, stat.size - budget)
    text = readSlice(file, start, stat.size - start)
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    events = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Event
        if (typeof parsed.type === 'string') events.push(parsed)
      } catch {
        // 最后半行可能是正在写的；保留之前的完整事件
      }
    }
    if (events.length > 0 || start === 0 || budget >= 8 * 1024 * 1024) break
    budget = Math.min(8 * 1024 * 1024, budget * 2)
  }

  const last = events.at(-1)
  const total = last && typeof last.seq === 'number' ? last.seq + 1 : events.length
  return { events, total, truncated: start > 0 }
}

export function sessionStateOf(event: TailEvent | undefined): SessionState {
  if (!event) return 'unknown'
  if (event.type === 'turn.completed') {
    return event.payload?.status === 'waiting' ? 'waiting' : 'idle'
  }
  if (TERMINAL_AGENT_EVENTS.has(event.type)) return 'done'
  if (event.type === 'session.created') return 'idle'
  return 'running'
}

interface SessionStateCacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly state: SessionState
  readonly lastActivity?: string
}

/** 列表轮询用：文件没变就只 stat，不重复读尾部。 */
const sessionStateCache = new Map<string, SessionStateCacheEntry>()

export function tailSessionState(file: string): {
  state: SessionState
  lastActivity?: string
} {
  const stat = statSync(file)
  const cached = sessionStateCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return {
      state: cached.state,
      ...(cached.lastActivity ? { lastActivity: cached.lastActivity } : {}),
    }
  }

  const last = readSessionTail(file, 32 * 1024).events.at(-1)
  const state = sessionStateOf(last)
  const result = {
    state,
    ...(last?.ts ? { lastActivity: last.ts } : {}),
  }
  sessionStateCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ...result })
  if (sessionStateCache.size > 256) {
    for (const key of sessionStateCache.keys()) {
      if (key === file) continue
      sessionStateCache.delete(key)
      if (sessionStateCache.size <= 128) break
    }
  }
  return result
}

export function sessionInfo(
  dataRoot: string,
  sessionId: string,
  lifecycle: SessionLifecycleState = 'active',
): SessionInfo | undefined {
  const file = sessionFile(dataRoot, sessionId)
  if (!existsSync(file)) return undefined
  const stat = statSync(file)
  if (!stat.isFile()) return undefined
  const origin = readOrigin(file, basename(file))
  return {
    id: sessionId,
    file,
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    ...(origin.createdBy ? { createdBy: origin.createdBy } : {}),
    ...(origin.createdFrom ? { createdFrom: origin.createdFrom } : {}),
    ...(origin.reason ? { reason: origin.reason } : {}),
    kind: origin.kind,
    lifecycle,
  }
}

export interface ListSessionsOptions {
  /** 由生命周期投影回答；不传就全部按 active 处理。 */
  readonly lifecycle?: (sessionId: string) => SessionLifecycleState
  /** 默认不列归档会话 */
  readonly includeArchived?: boolean
  /** 默认不列软删除会话 */
  readonly includeDeleted?: boolean
  /** true = 尾读每条会话的最后事件，补 state/lastActivity */
  readonly withState?: boolean
  /** true = 扫每条会话开头，补 title */
  readonly withTitle?: boolean
}

export function listSessions(dataRoot: string, options: ListSessionsOptions = {}): SessionInfo[] {
  const dir = sessionsDir(dataRoot)
  if (!existsSync(dir)) return []

  const sessions: SessionInfo[] = []
  for (const name of readdirSync(dir)) {
    const match = SESSION_FILE.exec(name)
    if (!match) continue
    const file = join(dir, name)
    const stat = statSync(file)
    if (!stat.isFile()) continue

    // 旧 agent 流没有 session.created，仍由 listAgentRuns 单独展示；
    // 新 agent 会话有溯源，进入用户的扁平会话列表。
    const origin = readOrigin(file, name)
    if (name.startsWith('agent-') && !origin.createdBy) continue

    const id = match[1]!
    const lifecycle = options.lifecycle?.(id) ?? 'active'
    if (lifecycle === 'deleted' && options.includeDeleted !== true) continue
    if (lifecycle === 'archived' && options.includeArchived !== true) continue
    let tail: { state: SessionState; lastActivity?: string } | undefined
    if (options.withState) {
      try {
        tail = tailSessionState(file)
      } catch {
        // 文件在 readdir 之后被删/轮转：列表不因一条竞态失败
      }
    }
    let title: string | undefined
    if (options.withTitle) {
      try {
        title = sessionTitle(file)
      } catch {
        // 标题只是列表装饰；读不到不影响会话本身
      }
    }

    sessions.push({
      id,
      file,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      ...(origin.createdBy ? { createdBy: origin.createdBy } : {}),
      ...(origin.createdFrom ? { createdFrom: origin.createdFrom } : {}),
      ...(origin.reason ? { reason: origin.reason } : {}),
      kind: origin.kind,
      lifecycle,
      ...(tail ? { state: tail.state } : {}),
      ...(tail?.lastActivity ? { lastActivity: tail.lastActivity } : {}),
      ...(title ? { title } : {}),
    })
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export interface AgentRunInfo {
  readonly id: string
  readonly preset: string
  readonly status: string
  readonly summary: string
  readonly updatedAt: string
  readonly lifecycle: SessionLifecycleState
}

export interface ListAgentRunsOptions {
  readonly lifecycle?: (sessionId: string) => SessionLifecycleState
  readonly includeArchived?: boolean
  readonly includeDeleted?: boolean
}

const TERMINAL = new Set(['agent.completed', 'agent.failed', 'agent.cancelled', 'agent.interrupted'])

interface AgentRunCacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly preset: string
  readonly status: string
  readonly summary: string
  readonly updatedAt: string
}

/** agent 流可能很长；按 mtime/size 缓存解析结果，轮询时只 stat。 */
const agentRunCache = new Map<string, AgentRunCacheEntry>()

function parseAgentRun(file: string): Omit<AgentRunCacheEntry, 'mtimeMs' | 'size'> | undefined {
  let preset = ''
  let status = 'unknown'
  let summary = ''
  let updatedAt = ''
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as {
        ts?: string
        type?: string
        payload?: Record<string, unknown>
      }
      const type = event.type ?? ''
      if (!type.startsWith('agent.')) continue
      updatedAt = event.ts ?? updatedAt
      if (type === 'agent.requested' && typeof event.payload?.preset === 'string') {
        preset = event.payload.preset
      }
      if (TERMINAL.has(type)) {
        status = type.slice('agent.'.length)
        summary = typeof event.payload?.summary === 'string' ? event.payload.summary : ''
      }
    }
  } catch {
    return undefined
  }
  return { preset, status, summary, updatedAt }
}

function cachedAgentRun(file: string): AgentRunCacheEntry | undefined {
  const stat = statSync(file)
  const cached = agentRunCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
  const parsed = parseAgentRun(file)
  if (!parsed) return undefined
  const next: AgentRunCacheEntry = { ...parsed, mtimeMs: stat.mtimeMs, size: stat.size }
  agentRunCache.set(file, next)
  if (agentRunCache.size > 256) {
    for (const key of agentRunCache.keys()) {
      if (key === file) continue
      agentRunCache.delete(key)
      if (agentRunCache.size <= 128) break
    }
  }
  return next
}

/** 从 agent 事件流读终态：磁盘是唯一的跨进程记录。 */
export function listAgentRuns(
  dataRoot: string,
  options: ListAgentRunsOptions = {},
): AgentRunInfo[] {
  const dir = sessionsDir(dataRoot)
  if (!existsSync(dir)) return []

  const runs: AgentRunInfo[] = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    const id = name.slice(0, -'.jsonl'.length)
    const lifecycle = options.lifecycle?.(id) ?? 'active'
    if (lifecycle === 'deleted' && options.includeDeleted !== true) continue
    if (lifecycle === 'archived' && options.includeArchived !== true) continue
    let parsed: AgentRunCacheEntry | undefined
    try {
      parsed = cachedAgentRun(file)
    } catch {
      // 文件在 readdir 之后被删/轮转
      continue
    }
    if (!parsed) continue

    runs.push({
      id,
      preset: parsed.preset,
      status: parsed.status,
      summary: parsed.summary,
      updatedAt: parsed.updatedAt,
      lifecycle,
    })
  }

  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function newSessionId(now: Date = new Date(), timeZone = 'Asia/Shanghai'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const stamp = `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`
  const suffix = Math.random().toString(36).slice(2, 6)
  return `session-${stamp}-${suffix}`
}
