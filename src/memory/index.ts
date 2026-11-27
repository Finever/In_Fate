import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export interface IndexItem {
  readonly path: string
  readonly what: string
  readonly n?: number
  readonly updated?: string
}

export interface IndexList {
  readonly kind: 'indexlist'
  readonly generated: string
  readonly root: string
  readonly items: readonly IndexItem[]
}

export interface ExtraDir {
  readonly path: string
  readonly what: string
}

export interface IndexOptions {
  readonly memoryRoot: string
  readonly detailDir?: string
  readonly outPath?: string
  /** 额外跳过的目录名 */
  readonly skip?: readonly string[]
  /** 目录清单可换；默认按当前记忆库的结构 */
  readonly extraDirs?: readonly ExtraDir[]
  readonly now?: Date
}

const DEFAULT_SKIP = ['_trash', '_archive', '__pycache__']

const DEFAULT_EXTRA_DIRS: readonly ExtraDir[] = [
  { path: 'log', what: '原始流水（IF 从会话事件生成）' },
  { path: 'summaries', what: '条目摘要（供选择器用）' },
  { path: 'proposals', what: '待处理的记忆提议' },
  { path: 'agents', what: 'agent manifest 与身份槽位' },
]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期，不用 toISOString（那是 UTC，会跨日）。 */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timeStamp(date: Date): string {
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function walkJson(dir: string, skip: ReadonlySet<string>, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkJson(full, skip, out)
    else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'indexlist.json') out.push(full)
  }
}

function countFiles(dir: string, skip: ReadonlySet<string>): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) n += countFiles(full, skip)
    else if (entry.isFile()) n += 1
  }
  return n
}

function mtimeDate(path: string): string {
  try {
    return localDate(statSync(path).mtime)
  } catch {
    return ''
  }
}

/** 生成索引对象，不落盘。 */
export function generateIndex(options: IndexOptions): IndexList {
  const root = options.memoryRoot
  const detail = options.detailDir ?? join(root, 'detail')
  const skip = new Set([...DEFAULT_SKIP, ...(options.skip ?? [])])
  const items: IndexItem[] = []

  const files: string[] = []
  walkJson(detail, skip, files)
  for (const file of files.sort()) {
    const rel = relative(detail, file).split(sep).join('/')
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as {
        introduction?: string
        filename?: string
        entries?: unknown
      }
      items.push({
        path: `detail/${rel}`,
        what: doc.introduction || doc.filename || '',
        n: Array.isArray(doc.entries) ? doc.entries.length : 0,
        updated: mtimeDate(file),
      })
    } catch {
      items.push({ path: `detail/${rel}`, what: '（读不了）' })
    }
  }

  for (const extra of options.extraDirs ?? DEFAULT_EXTRA_DIRS) {
    const dir = join(root, extra.path)
    if (!existsSync(dir)) continue
    items.push({
      path: `${extra.path}/`,
      what: extra.what,
      n: countFiles(dir, skip),
      updated: mtimeDate(dir),
    })
  }

  for (const name of ['README.md', '_设计草案.md']) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    items.push({
      path: name,
      what: name === 'README.md' ? '使用说明书' : '重构设计草案',
      updated: mtimeDate(file),
    })
  }

  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    kind: 'indexlist',
    generated: timeStamp(options.now ?? new Date()),
    root,
    items,
  }
}

/** 生成并写盘。 */
export function writeIndex(options: IndexOptions): IndexList {
  const detail = options.detailDir ?? join(options.memoryRoot, 'detail')
  const out = options.outPath ?? join(detail, 'indexlist.json')
  const doc = generateIndex(options)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(doc, null, 4) + '\n', 'utf8')
  return doc
}
