import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeSegment, assertWithin } from '../core/safe-path.ts'
import { readLog, type LogRow } from './log.ts'

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TEXT_CAP = 400

export interface LogFileInfo {
  readonly sid: string
  readonly size: number
  readonly mtime: number
}

export interface LogTreeDay {
  readonly day: string
  readonly files: readonly LogFileInfo[]
}

export interface LogTree {
  readonly days: readonly LogTreeDay[]
}

export interface LogViewRow {
  readonly n?: number
  readonly who: string
  readonly kind: 'msg' | 'tool'
  readonly ts: string
  readonly body: string
}

export interface LogViewPage {
  readonly total: number
  readonly offset: number
  readonly rows: readonly LogViewRow[]
  readonly focus: number | null
  readonly meta?: Readonly<Record<string, string>>
}

export interface LogSearchHit {
  readonly day: string
  readonly sid: string
  readonly n?: number
  readonly who: string
  readonly ts: string
  readonly text: string
  readonly trunc: boolean
  readonly addr: string
}

export interface LogSearchResult {
  readonly hits: readonly LogSearchHit[]
  readonly total: number
}

export interface LogPageOptions {
  readonly offset?: number
  readonly limit?: number
  readonly jumpN?: number
}

function logRoot(memoryRoot: string): string {
  return join(memoryRoot, 'log')
}

function fileInfo(path: string, sid: string): LogFileInfo | undefined {
  try {
    const stat = statSync(path)
    return { sid, size: stat.size, mtime: stat.mtimeMs }
  } catch {
    return undefined
  }
}

/** 天倒序，天内按 mtime 倒序。 */
export function listLogTree(memoryRoot: string): LogTree {
  const root = logRoot(memoryRoot)
  if (!existsSync(root)) return { days: [] }
  const days = new Map<string, LogFileInfo[]>()
  for (const year of readdirSync(root, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue
    const yearDir = join(root, year.name)
    for (const month of readdirSync(yearDir, { withFileTypes: true })) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue
      const monthDir = join(yearDir, month.name)
      for (const day of readdirSync(monthDir, { withFileTypes: true })) {
        if (!day.isDirectory() || !DAY_PATTERN.test(day.name)) continue
        const dayDir = join(monthDir, day.name)
        for (const file of readdirSync(dayDir, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
          const sid = file.name.slice(0, -'.jsonl'.length)
          const info = fileInfo(join(dayDir, file.name), sid)
          if (!info) continue
          const list = days.get(day.name) ?? []
          list.push(info)
          days.set(day.name, list)
        }
      }
    }
  }
  return {
    days: [...days.entries()]
      .map(([day, files]) => ({
        day,
        files: files.sort((a, b) => b.mtime - a.mtime),
      }))
      .sort((a, b) => b.day.localeCompare(a.day)),
  }
}

function resolveLogPath(memoryRoot: string, day: string, sid: string): string {
  if (!DAY_PATTERN.test(day)) throw new Error(`invalid log day: ${day}`)
  const safeSid = assertSafeSegment(sid, 'log session')
  const [year, month] = day.split('-')
  const root = logRoot(memoryRoot)
  return assertWithin(
    root,
    join(root, year!, month!, day, `${safeSid}.jsonl`),
    'log file',
  )
}

function metaOf(row: LogRow): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['agent_name', 'session', 'date', 'start', 'converted']) {
    const value = row[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** 读一页；jumpN 时给前后文和 focus。 */
export function readLogPage(
  memoryRoot: string,
  day: string,
  sid: string,
  options: LogPageOptions = {},
): LogViewPage {
  const path = resolveLogPath(memoryRoot, day, sid)
  const raw = existsSync(path) ? readLog(path, { skipBadLines: true }) : []
  let meta: Record<string, string> | undefined
  const rows: LogViewRow[] = []

  for (const row of raw) {
    if (row._meta !== undefined) {
      meta = metaOf(row)
      continue
    }
    if (row.type === 'turn-start') continue
    let kind: 'msg' | 'tool' = 'msg'
    let body = ''
    if (typeof row.text === 'string' && row.text.length > 0) {
      body = row.text
    } else if (typeof row.p === 'string' && row.p.length > 0) {
      body = row.p
    } else if (row.type === 'tool') {
      kind = 'tool'
      body = `${row.call ?? ''}${row.hint ? ` · ${row.hint}` : ''}`
    } else {
      kind = 'tool'
      try {
        body = JSON.stringify(row).slice(0, 300)
      } catch {
        body = String(row)
      }
    }
    rows.push({
      ...(typeof row.n === 'number' ? { n: row.n } : {}),
      who: typeof row.who === 'string' ? row.who : '',
      kind,
      ts: typeof row.ts === 'string' ? row.ts : '',
      body,
    })
  }

  const total = rows.length
  let focus: number | null = null
  let start = options.offset ?? 0
  if (options.jumpN !== undefined) {
    const index = rows.findIndex(row => row.n === options.jumpN)
    if (index >= 0) {
      focus = index
      start = Math.max(0, index - 20)
    }
  }
  start = Math.max(0, Math.min(start, total))
  const limit = Math.max(1, Math.min(options.limit ?? 200, 400))
  return {
    total,
    offset: start,
    rows: rows.slice(start, start + limit),
    focus,
    ...(meta ? { meta } : {}),
  }
}

/** 全库搜日志：粗筛原文子串，命中再按 JSON 文本核对。 */
export function searchLogs(
  memoryRoot: string,
  query: string,
  limit = 200,
): LogSearchResult {
  const needle = query.trim()
  if (!needle) return { hits: [], total: 0 }
  const lower = needle.toLowerCase()
  const hits: LogSearchHit[] = []
  let total = 0

  for (const day of listLogTree(memoryRoot).days) {
    for (const file of day.files) {
      let path: string
      try {
        path = resolveLogPath(memoryRoot, day.day, file.sid)
      } catch {
        continue
      }
      if (!existsSync(path)) continue
      let rows: LogRow[]
      try {
        rows = readLog(path, { skipBadLines: true })
      } catch {
        continue
      }
      for (const row of rows) {
        if (row._meta !== undefined || row.type === 'turn-start') continue
        const text = typeof row.text === 'string'
          ? row.text
          : typeof row.p === 'string' ? row.p : ''
        if (!text || text.includes('<task-notification')) continue
        if (!text.toLowerCase().includes(lower)) continue
        total += 1
        if (hits.length >= limit) continue
        hits.push({
          day: day.day,
          sid: file.sid,
          ...(typeof row.n === 'number' ? { n: row.n } : {}),
          who: typeof row.who === 'string' ? row.who : '',
          ts: typeof row.ts === 'string' ? row.ts : '',
          text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text,
          trunc: text.length > TEXT_CAP,
          addr: `${day.day}-${file.sid}-${row.n ?? 0}`,
        })
      }
    }
  }
  return { hits, total }
}
