/**
 * 会话目录：一个会话一个事件文件。
 *
 * 只认 `sessions/<id>.jsonl`；分段文件 `<id>.jsonl.1` 属于原会话。
 *
 * @module if/app/session
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionInfo {
  readonly id: string
  readonly file: string
  readonly bytes: number
  readonly updatedAt: string
}

export function sessionsDir(dataRoot: string): string {
  return join(dataRoot, 'sessions')
}

export function sessionFile(dataRoot: string, sessionId: string): string {
  return join(sessionsDir(dataRoot), `${sessionId}.jsonl`)
}

const SESSION_FILE = /^(.+)\.jsonl$/

export function listSessions(dataRoot: string): SessionInfo[] {
  const dir = sessionsDir(dataRoot)
  if (!existsSync(dir)) return []

  const sessions: SessionInfo[] = []
  for (const name of readdirSync(dir)) {
    const match = SESSION_FILE.exec(name)
    if (!match) continue
    // agent 流不是会话，单独由 listAgentRuns 读。
    if (name.startsWith('agent-')) continue
    const file = join(dir, name)
    const stat = statSync(file)
    if (!stat.isFile()) continue
    sessions.push({
      id: match[1]!,
      file,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
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
