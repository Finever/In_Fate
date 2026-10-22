/**
 * 原话地址与检索。
 *
 * 地址形状：`年-月-日-<会话id>-n`。会话 id 里本身有连字符，所以解析
 * 必须从两端切：左边固定 10 位日期，右边是最后的 n。
 *
 * 检索口径与 find_quote.py 一致：只认有 text 的行，_meta 跳过，
 * 匹配的是“用户说的原话”，所以默认只收 userName 匹配的行。
 *
 * @module if/memory/quote
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeSegment } from '../core/safe-path.ts'

export interface QuoteAddress {
  readonly date: string
  readonly session: string
  readonly n: number
}

export const ADDRESS_PATTERN = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9._-]{1,128})-(\d+)$/

export function formatAddress(date: string, session: string, n: number): string {
  return `${date}-${session}-${n}`
}

export function parseAddress(address: string): QuoteAddress {
  const match = ADDRESS_PATTERN.exec(address)
  if (!match) throw new Error(`invalid quote address: ${address}`)
  const session = assertSafeSegment(match[2]!, 'quote session')
  const n = Number(match[3])
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`invalid quote address number: ${address}`)
  }
  return { date: match[1]!, session, n }
}

export function isValidAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address)
}

export interface QuoteHit {
  readonly address: string
  readonly who?: string
  readonly text: string
  readonly previous?: { readonly who?: string; readonly text: string }
}

export interface FindQuoteOptions {
  readonly memoryRoot: string
  readonly phrase: string
  /** 只收这个人的话（原话只可能是他说的） */
  readonly userName?: string
  readonly limit?: number
  /** 只扫指定日期（YYYY-MM-DD）；不传扫全部 */
  readonly date?: string
}

function walkLogs(root: string, out: string[]): void {
  const logRoot = join(root, 'log')
  if (!existsSync(logRoot)) return
  for (const year of readdirSync(logRoot, { withFileTypes: true })) {
    if (!year.isDirectory()) continue
    const yearDir = join(logRoot, year.name)
    for (const month of readdirSync(yearDir, { withFileTypes: true })) {
      if (!month.isDirectory()) continue
      const monthDir = join(yearDir, month.name)
      for (const day of readdirSync(monthDir, { withFileTypes: true })) {
        if (!day.isDirectory() || !day.name.startsWith('20')) continue
        const dayDir = join(monthDir, day.name)
        for (const file of readdirSync(dayDir, { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith('.jsonl')) out.push(join(dayDir, file.name))
        }
      }
    }
  }
}

interface LogRecord {
  readonly who?: string
  readonly text?: string
  readonly n?: number
  readonly _meta?: number
}

function readRecords(path: string): LogRecord[] {
  const out: LogRecord[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    try {
      out.push(JSON.parse(text) as LogRecord)
    } catch {
      throw new Error(`corrupt log line: ${path}:${index + 1}`)
    }
  })
  return out
}

/** 在所有流水里找一句话。命中顺序按文件、行序。 */
export function findQuotes(options: FindQuoteOptions): QuoteHit[] {
  const files: string[] = []
  walkLogs(options.memoryRoot, files)
  files.sort()

  const hits: QuoteHit[] = []
  const limit = options.limit ?? 30

  for (const file of files) {
    const parts = file.replace(/\\/g, '/').split('/')
    const dirDate = parts.at(-2) ?? ''
    if (options.date && dirDate !== options.date) continue
    const session = (parts.at(-1) ?? '').replace(/\.jsonl$/, '')

    const records = readRecords(file)
    let previous: { who?: string; text: string } | undefined
    for (const record of records) {
      if (record._meta !== undefined) continue
      const text = record.text ?? ''
      if (!text) continue

      if (!options.userName || record.who === options.userName) {
        if (text.includes(options.phrase)) {
          hits.push({
            address: formatAddress(dirDate, session, record.n ?? 0),
            who: record.who,
            text,
            previous,
          })
          if (hits.length >= limit) return hits
        }
      }
      previous = { who: record.who, text }
    }
  }

  return hits
}
