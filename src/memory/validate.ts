import {
  ENTRY_KEYS,
  ID_PATTERN,
  QUOTE_TAGS,
  TRUST_TAGS,
  type MemoryFile,
  type QuoteTag,
  type TrustTag,
} from './entry.ts'

export interface Issue {
  readonly level: 'error' | 'warning'
  /** 出问题的位置：文件、条目 id、原话序号 */
  readonly path: string
  readonly message: string
}

export interface ValidationStats {
  readonly entries: number
  readonly quotes: number
  readonly withAddr: number
}

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly Issue[]
  readonly warnings: readonly Issue[]
  readonly stats: ValidationStats
}

export interface ValidateOptions {
  /** true 时缺 log-addr 记为错误（写入前用） */
  readonly requireQuoteAddress?: boolean
}

const TRUST = new Set<string>(TRUST_TAGS)
const QTags = new Set<string>(QUOTE_TAGS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验一个已解析的记忆文件。 */
export function validateFile(doc: unknown, options: ValidateOptions = {}): ValidationResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (path: string, message: string): void => {
    errors.push({ level: 'error', path, message })
  }
  const warn = (path: string, message: string): void => {
    warnings.push({ level: 'warning', path, message })
  }

  let stats: ValidationStats = { entries: 0, quotes: 0, withAddr: 0 }

  if (!isRecord(doc)) {
    err('$', '顶层不是对象')
    return { ok: false, errors, warnings, stats }
  }

  for (const key of ['project', 'filename', 'introduction', 'entries']) {
    if (!(key in doc)) err('$', `顶层少了 ${key}`)
  }

  const entries = doc.entries
  if (!Array.isArray(entries)) {
    err('$', 'entries 不是数组')
    return { ok: false, errors, warnings, stats }
  }

  const seen = new Map<string, number>()
  let quotes = 0
  let withAddr = 0

  entries.forEach((entry, index) => {
    const at = isRecord(entry) && typeof entry.id === 'string' ? entry.id : `entries[${index}]`
    if (!isRecord(entry)) {
      err(at, '条目不是对象')
      return
    }

    for (const key of ENTRY_KEYS) {
      if (key === 'rev-time' || key === 'at' || key === 'quotes') continue
      if (entry[key] === undefined || entry[key] === null || entry[key] === '') {
        err(at, `少了 ${key}`)
      }
    }

    if (typeof entry.tag !== 'string' || !TRUST.has(entry.tag)) {
      err(at, `tag 不合法：${JSON.stringify(entry.tag)}`)
    }

    if (typeof entry.id === 'string') {
      if (!ID_PATTERN.test(entry.id)) err(at, 'id 形状不对（要 <文件名>-0001 这样）')
      seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1)
    }

    const list = entry.quotes
    if (list === undefined) return
    if (!Array.isArray(list)) {
      err(at, 'quotes 不是数组')
      return
    }

    list.forEach((quote, qi) => {
      quotes += 1
      const qat = `${at}.quotes[${qi}]`
      if (!isRecord(quote)) {
        err(qat, '原话不是对象')
        return
      }
      if (typeof quote.say !== 'string' || quote.say.length === 0) {
        err(qat, '没有 say')
      }

      if (quote.tag !== undefined) {
        if (!Array.isArray(quote.tag) || quote.tag.length === 0) {
          err(qat, 'tag 要是非空数组')
        } else {
          const bad = quote.tag.filter((tag): tag is string => typeof tag === 'string' && !QTags.has(tag))
          if (bad.length > 0) err(qat, `tag 有不在七类里的：${bad.join('、')}`)
        }
      }

      if (typeof quote['log-addr'] === 'string' && quote['log-addr'].length > 0) {
        withAddr += 1
        return
      }
      const msg = `没有 log-addr（${String(quote.say).slice(0, 26)}）`
      if (options.requireQuoteAddress) err(qat, msg)
      else warn(qat, msg)
    })
  })

  for (const [id, count] of seen) {
    if (count > 1) err(id, `id 重复 x${count}`)
  }

  stats = { entries: entries.length, quotes, withAddr }
  return { ok: errors.length === 0, errors, warnings, stats }
}

/** 把结果压成一行，给命令行用。 */
export function summarize(result: ValidationResult): string {
  if (result.ok) {
    const w = result.warnings.length > 0 ? `，${result.warnings.length} 条提醒` : ''
    return `✓ 条目 ${result.stats.entries}，原话 ${result.stats.quotes}，带地址 ${result.stats.withAddr}${w}`
  }
  return `✗ ${result.errors.length} 个错误`
}

export function isTrustTag(value: unknown): value is TrustTag {
  return typeof value === 'string' && TRUST.has(value)
}

export function isQuoteTag(value: unknown): value is QuoteTag {
  return typeof value === 'string' && QTags.has(value)
}
