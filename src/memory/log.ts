/**
 * 记忆流水（hook_log）的格式与写入。
 *
 * 一行一块，只追加。文件头一行 _meta；每轮 turn-start → 块 → turn-end。
 * thinking 一律不记（见 hook_log.py）。坏行默认报错，不静默跳过。
 *
 * @module if/memory/log
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface LogMeta {
  readonly _meta: 1
  readonly agentid: string
  readonly agent_name: string
  readonly session: string
  readonly date: string
  readonly cwd: string
  readonly start: string
}

export interface LogRow {
  readonly n?: number
  readonly who?: string
  readonly type?: string
  readonly ts?: string
  readonly text?: string
  readonly p?: string
  readonly call?: string
  readonly hint?: string
  readonly args?: unknown
  readonly _meta?: 1
  readonly [key: string]: unknown
}

export type TurnBlock =
  | { readonly type: 'text'; readonly p: string }
  | { readonly type: 'tool'; readonly call: string; readonly hint: string; readonly args: unknown }
  | { readonly type: 'note'; readonly p: string }

/** 本地 HH:MM:SS。 */
export function clock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 本地日期 YYYY-MM-DD。 */
export function localDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface LocalLogStamp {
  readonly day: string
  readonly year: string
  readonly month: string
  readonly time: string
}

/** 按指定时区拆日期与时分秒；事件时间戳用 UTC，不能直接拿本地 getHours。 */
export function localLogStamp(date: Date, timeZone: string): LocalLogStamp {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return {
    day: `${year}-${month}-${day}`,
    year,
    month,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  }
}

/** 流水文件路径：<root>/<年>/<月>/<年-月-日>/<会话>.jsonl */
export function logPath(memoryRoot: string, date: Date, session: string): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return join(memoryRoot, 'log', year, month, localDate(date), `${session}.jsonl`)
}

export function logPathForDay(memoryRoot: string, stamp: LocalLogStamp, session: string): string {
  return join(memoryRoot, 'log', stamp.year, stamp.month, stamp.day, `${session}.jsonl`)
}

export interface ReadLogOptions {
  /** 坏行是否跳过。默认 false（报错）。 */
  readonly skipBadLines?: boolean
}

export function readLog(path: string, options: ReadLogOptions = {}): LogRow[] {
  if (!existsSync(path)) return []
  const rows: LogRow[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    try {
      rows.push(JSON.parse(text) as LogRow)
    } catch {
      if (!options.skipBadLines) throw new Error(`corrupt log line: ${path}:${index + 1}`)
    }
  })
  return rows
}

/** 下一轮的 n：现有最大 n + 1。 */
export function nextTurn(rows: readonly LogRow[]): number {
  let max = 0
  for (const row of rows) {
    if (typeof row.n === 'number') max = Math.max(max, row.n)
  }
  return max + 1
}

/** 组装一轮：turn-start + 块 + turn-end。块不写 who，与 hook_log 一致。 */
export function buildTurn(
  n: number,
  who: string,
  blocks: readonly TurnBlock[],
  ts: string,
): LogRow[] {
  const rows: LogRow[] = [{ n, who, type: 'turn-start', ts }]
  for (const block of blocks) {
    rows.push({ n, ...block })
  }
  rows.push({ n, type: 'turn-end', ts })
  return rows
}

/** 只追加，UTF-8 + LF。 */
export function appendLog(path: string, rows: readonly LogRow[]): void {
  if (rows.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { encoding: 'utf8' })
}

/** 文件不存在时写 _meta 头；已存在就不碰。 */
export function ensureMeta(path: string, meta: LogMeta): void {
  if (existsSync(path)) return
  appendLog(path, [meta as unknown as LogRow])
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const
const TEXT_KEYS = ['command', 'pattern', 'query', 'url', 'prompt', 'description'] as const

/** 从工具参数里机械取一个能认的标识。取字段，不解释。 */
export function hintFromArgs(
  args: unknown,
  keys: { readonly path?: readonly string[]; readonly text?: readonly string[] } = {},
): string {
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>

  for (const key of keys.path ?? PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return basename(value)
  }
  for (const key of keys.text ?? TEXT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      return value.replace(/\n/g, ' ').slice(0, 60)
    }
  }
  return ''
}
