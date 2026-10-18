/**
 * 记忆条目的形状：键序、枚举、编号规则。
 *
 * 这里只放**定义**，不放校验逻辑（在 validate.ts）和写入逻辑（在 write.ts）。
 * 三条枚举是记忆系统的硬规矩，不随场景改；要改，改这里一处。
 *
 * @module if/memory/entry
 */

/** 文件顶层键序。 */
export const FILE_KEYS = ['project', 'filename', 'introduction', 'entries'] as const

/** 条目键序。写盘时按这个顺序排，未知键追加在末尾。 */
export const ENTRY_KEYS = ['id', 'rec-time', 'rev-time', 'at', 'tag', 'content', 'quotes'] as const

/** 原话键序。 */
export const QUOTE_KEYS = ['say', 'at', 'tag', 'log-addr'] as const

/** 三档可信度。闭集。 */
export const TRUST_TAGS = ['确信', '可信', '有疑'] as const

/** 原话七类。闭集。 */
export const QUOTE_TAGS = ['禁令', '需求', '想法', '疑问', '认可', '否定', '表达交流'] as const

/** id 形状：<文件名>-0001。 */
export const ID_PATTERN = /^.+-(\d{4})$/

export type TrustTag = (typeof TRUST_TAGS)[number]
export type QuoteTag = (typeof QUOTE_TAGS)[number]

export interface Quote {
  readonly say: string
  readonly at?: string | null
  readonly tag?: readonly QuoteTag[]
  readonly 'log-addr'?: string
}

export interface Entry {
  readonly id: string
  readonly 'rec-time': string
  readonly 'rev-time': string | null
  readonly at: string | null
  readonly tag: TrustTag
  readonly content: string
  readonly quotes: readonly Quote[]
}

export interface MemoryFile {
  readonly project: string
  readonly filename: string
  readonly introduction: string
  readonly entries: readonly Entry[]
}

/** 按固定键序重排一个对象；未知键保持原顺序追加在后面。 */
export function orderBy<T extends Record<string, unknown>>(
  input: T,
  keys: readonly string[],
): T {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in input) out[key] = input[key]
  }
  for (const key of Object.keys(input)) {
    if (!(key in out)) out[key] = input[key]
  }
  return out as T
}

export function orderFile(file: MemoryFile): MemoryFile {
  return orderBy(file as unknown as Record<string, unknown>, FILE_KEYS) as unknown as MemoryFile
}

export function orderEntry(entry: Entry | Record<string, unknown>): Entry {
  return orderBy(entry as Record<string, unknown>, ENTRY_KEYS) as unknown as Entry
}

export function orderQuote(quote: Quote | Record<string, unknown>): Quote {
  return orderBy(quote as Record<string, unknown>, QUOTE_KEYS) as unknown as Quote
}

/** 从现有 id 里取最大编号；没有条目返回 0。 */
export function maxIdNumber(entries: readonly Entry[]): number {
  let max = 0
  for (const entry of entries) {
    const match = ID_PATTERN.exec(entry.id ?? '')
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

/** 下一个 id。<fileName> 必须与文件里的 filename 字段一致。 */
export function nextId(fileName: string, entries: readonly Entry[]): string {
  const n = maxIdNumber(entries) + 1
  return `${fileName}-${String(n).padStart(4, '0')}`
}
