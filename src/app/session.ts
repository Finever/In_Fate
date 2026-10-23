/**
 * 会话目录：一个会话一个事件文件。
 *
 * 只认 `sessions/<id>.jsonl`；分段文件 `<id>.jsonl.1` 属于原会话。
 *
 * @module if/app/session
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertSafeSessionId } from '../core/safe-path.ts'

export interface SessionOrigin {
  readonly sessionId: string
  readonly eventId?: string
}

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

export function sessionInfo(dataRoot: string, sessionId: string): SessionInfo | undefined {
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
  }
}

export function listSessions(dataRoot: string): SessionInfo[] {
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

    sessions.push({
      id: match[1]!,
      file,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      ...(origin.createdBy ? { createdBy: origin.createdBy } : {}),
      ...(origin.createdFrom ? { createdFrom: origin.createdFrom } : {}),
      ...(origin.reason ? { reason: origin.reason } : {}),
      kind: origin.kind,
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
}

const TERMINAL = new Set(['agent.completed', 'agent.failed', 'agent.cancelled', 'agent.interrupted'])

/** 从 agent 事件流读终态：磁盘是唯一的跨进程记录。 */
export function listAgentRuns(dataRoot: string): AgentRunInfo[] {
  const dir = sessionsDir(dataRoot)
  if (!existsSync(dir)) return []

  const runs: AgentRunInfo[] = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue
    const file = join(dir, name)
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
      continue
    }

    runs.push({
      id: name.slice(0, -'.jsonl'.length),
      preset,
      status,
      summary,
      updatedAt,
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
