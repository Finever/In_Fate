/**
 * 记忆库门面：给设置页用的文件树、内容编辑与结构操作。
 *
 * `log/` 永远只读；`.state/`、`.git/`、`indexlist.json`、`meta.json` 是系统件。
 * detail 的结构化校验仍交给 MemoryStore；这里负责路径、树、移动、回收站。
 *
 * @module if/memory/library
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { withFileLock } from '../core/lock.ts'
import { assertWithin } from '../core/safe-path.ts'
import { validateFile } from './validate.ts'
import {
  isProtectedMemorySegment,
  parseDetailTarget,
  type MemoryDocument,
  type MemoryStore,
} from './store.ts'

export type MemoryLibraryArea = 'detail' | 'summaries' | 'proposals' | 'agents' | 'root'

export interface MemoryLibraryNode {
  readonly path: string
  readonly name: string
  readonly kind: 'directory' | 'file'
  readonly area: MemoryLibraryArea
  readonly readOnly: boolean
  readonly target?: string
  readonly private?: boolean
  readonly invalid?: string
  readonly entries?: number
  readonly bytes?: number
  readonly updatedAt?: string
}

export interface MemoryLibraryFile {
  readonly path: string
  readonly area: MemoryLibraryArea
  readonly readOnly: boolean
  readonly text: string
  readonly bytes: number
  readonly updatedAt: string
  readonly json?: unknown
  readonly document?: MemoryDocument
  readonly invalid?: string
}

export interface MemoryTrashEntry {
  readonly id: string
  readonly original: string
  readonly name: string
  readonly kind: 'directory' | 'file'
  readonly movedAt: string
}

export interface MemoryLibraryOptions {
  readonly root: string
  readonly store: MemoryStore
  readonly onChange?: (paths: readonly string[]) => void
  /** 写前校验系统文件（例如 policy.json / agent.json）。 */
  readonly validateWrite?: (path: string, text: string) => void
  /** 写后刷新对应运行时缓存。 */
  readonly afterWrite?: (path: string) => void
}

interface ResolvedPath {
  readonly path: string
  readonly area: MemoryLibraryArea
  readonly parts: readonly string[]
  readonly abs: string
  readonly readOnly: boolean
  readonly target?: string
}

const AREAS = new Set<MemoryLibraryArea>(['detail', 'summaries', 'proposals', 'agents'])
const ROOT_READ_ONLY = new Set(['meta.json'])
const ROOT_ALLOWED = /\.(md|txt|json)$/i
const MAX_FILE_BYTES = 4 * 1024 * 1024
const TRASH_DIR = '_trash'
const TRASH_META = 'meta.json'

function slash(path: string): string {
  return path.split(sep).join('/')
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function rejectSymlink(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`memory library symlink is not allowed: ${path}`)
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, path)
}

function readText(path: string): string {
  const stat = statSync(path)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`memory library file is too large: ${path}`)
  const text = readFileSync(path, 'utf8')
  if (text.includes('\0')) throw new Error(`memory library binary file is not editable: ${path}`)
  return text
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function fileStamp(path: string): { bytes: number; updatedAt: string } {
  const stat = statSync(path)
  return { bytes: stat.size, updatedAt: stat.mtime.toISOString() }
}

export class MemoryLibrary {
  readonly root: string
  readonly store: MemoryStore
  private readonly onChange?: (paths: readonly string[]) => void
  private readonly validateWrite?: (path: string, text: string) => void
  private readonly afterWrite?: (path: string) => void
  private readonly lockPath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: MemoryLibraryOptions) {
    this.root = options.root
    this.store = options.store
    this.onChange = options.onChange
    this.validateWrite = options.validateWrite
    this.afterWrite = options.afterWrite
    this.lockPath = join(this.root, '.state', 'library.lock')
  }

  tree(): MemoryLibraryNode[] {
    const out: MemoryLibraryNode[] = []
    for (const area of ['detail', 'summaries', 'proposals', 'agents'] as const) {
      const abs = join(this.root, area)
      if (!existsSync(abs)) continue
      this.walk(area, abs, out)
    }
    this.rootFiles(out)
    return out.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  }

  read(path: string): MemoryLibraryFile {
    const ref = this.resolve(path)
    rejectSymlink(ref.abs)
    if (!isFile(ref.abs)) throw new Error(`memory library path is not a file: ${path}`)
    const text = readText(ref.abs)
    const stamp = fileStamp(ref.abs)
    const parsed = parseJson(text)
    let document: MemoryDocument | undefined
    let invalid = path.endsWith('.json') && !parsed.ok ? parsed.error : undefined
    if (ref.area === 'detail') {
      if (!ref.target) invalid = 'detail path does not look like a memory file'
      else if (!parsed.ok) invalid = parsed.error
      else {
        try {
          document = this.store.read(ref.target)
          if (document.filename !== basename(path, '.json')) {
            invalid = `filename mismatch: ${document.filename} vs ${basename(path, '.json')}`
          }
        } catch (error) {
          invalid = error instanceof Error ? error.message : String(error)
        }
      }
    }
    return {
      path: ref.path,
      area: ref.area,
      readOnly: ref.readOnly,
      text,
      ...stamp,
      ...(parsed.ok ? { json: parsed.value } : {}),
      ...(document ? { document } : {}),
      ...(invalid ? { invalid } : {}),
    }
  }

  async write(path: string, text: string): Promise<MemoryLibraryFile> {
    const ref = this.resolve(path)
    if (ref.readOnly) throw new Error(`memory library path is read-only: ${path}`)
    const parsed = ref.area === 'detail' || path.endsWith('.json') ? parseJson(text) : undefined
    if (parsed && !parsed.ok) throw new Error(`invalid JSON: ${parsed.error}`)
    this.validateWrite?.(path, text)

    if (ref.area === 'detail') {
      if (!path.endsWith('.json') || !ref.target) {
        throw new Error(`detail files must end with .json: ${path}`)
      }
      const doc = parsed?.ok ? parsed.value : undefined
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('detail file must contain a JSON object')
      }
      await this.store.saveDocument(ref.target, doc as MemoryDocument)
      this.afterWrite?.(path)
      return this.read(path)
    }

    await this.locked(async () => {
      if (existsSync(ref.abs)) rejectSymlink(ref.abs)
      if (existsSync(dirname(ref.abs))) rejectSymlink(dirname(ref.abs))
      if (isDirectory(ref.abs)) throw new Error(`memory library path is a directory: ${path}`)
      atomicWrite(ref.abs, text)
      this.afterWrite?.(path)
      this.changed([ref.area])
    })
    return this.read(path)
  }

  async mkdir(path: string): Promise<void> {
    const ref = this.resolve(path)
    if (ref.readOnly) throw new Error(`memory library path is read-only: ${path}`)
    if (ref.area === 'root') throw new Error('cannot create a root directory')
    await this.locked(async () => {
      if (existsSync(ref.abs)) throw new Error(`memory library path already exists: ${path}`)
      if (existsSync(dirname(ref.abs))) rejectSymlink(dirname(ref.abs))
      mkdirSync(ref.abs)
      this.changed([ref.area])
    })
  }

  async move(from: string, to: string): Promise<void> {
    const source = this.resolve(from)
    const target = this.resolve(to)
    if (source.readOnly || target.readOnly) throw new Error('memory library path is read-only')
    if (source.area !== target.area) throw new Error('cannot move between memory areas')
    if (source.area === 'root') throw new Error('cannot move root files')
    if (source.abs === target.abs) return
    if (!existsSync(source.abs)) throw new Error(`memory library source not found: ${from}`)
    if (existsSync(target.abs)) throw new Error(`memory library target already exists: ${to}`)
    rejectSymlink(source.abs)
    if (existsSync(dirname(target.abs))) rejectSymlink(dirname(target.abs))
    const sourceIsDirectory = isDirectory(source.abs)
    if (source.area === 'detail') {
      if (sourceIsDirectory && target.path.endsWith('.json')) {
        throw new Error('a detail directory cannot be renamed to a .json file')
      }
      if (!sourceIsDirectory && !target.target) {
        throw new Error('a detail file must keep a .json target')
      }
    }
    if (sourceIsDirectory && target.abs.startsWith(`${source.abs}${sep}`)) {
      throw new Error('cannot move a directory into itself')
    }

    await this.locked(async () => {
      mkdirSync(dirname(target.abs), { recursive: true })
      const sourceStat = lstatSync(source.abs)
      renameSync(source.abs, target.abs)

      if (source.area === 'detail' && sourceStat.isFile() && source.target && target.target) {
        try {
          const raw = JSON.parse(readText(target.abs)) as Record<string, unknown>
          if (typeof raw.filename === 'string') {
            raw.filename = target.parts[target.parts.length - 1]!.replace(/\.json$/i, '')
            const validation = validateFile(raw)
            if (validation.ok) {
              atomicWrite(target.abs, `${JSON.stringify(raw, null, 2)}\n`)
            }
          }
        } catch {
          // 坏文件也允许移动；内容留给编辑器修，不把移动结果吞掉。
        }
        this.updateProposalTargets(source.target, target.target)
      } else if (source.area === 'detail' && sourceStat.isDirectory()) {
        this.updateProposalTargets(
          `detail:${source.parts.slice(1).join('/')}/`,
          `detail:${target.parts.slice(1).join('/')}/`,
        )
      }

      this.changed([source.area])
    })
  }

  async remove(path: string, options: { readonly permanent?: boolean } = {}): Promise<void> {
    const ref = this.resolve(path)
    if (ref.readOnly) throw new Error(`memory library path is read-only: ${path}`)
    if (ref.area === 'root') throw new Error('cannot remove root files from the library')
    if (!existsSync(ref.abs)) throw new Error(`memory library path not found: ${path}`)
    rejectSymlink(ref.abs)
    await this.locked(async () => {
      if (options.permanent) {
        rmSync(ref.abs, { recursive: true, force: true })
      } else {
        this.trashPath(ref)
      }
      this.changed([ref.area])
    })
  }

  trash(): MemoryTrashEntry[] {
    const root = join(this.root, 'detail', TRASH_DIR)
    if (!existsSync(root)) return []
    const out: MemoryTrashEntry[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || isHiddenName(entry.name)) continue
      const dir = join(root, entry.name)
      const metaPath = join(dir, TRASH_META)
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
          original?: unknown
          name?: unknown
          kind?: unknown
          movedAt?: unknown
        }
        if (typeof meta.original !== 'string') continue
        out.push({
          id: entry.name,
          original: meta.original,
          name: typeof meta.name === 'string' ? meta.name : basename(meta.original),
          kind: meta.kind === 'directory' ? 'directory' : 'file',
          movedAt: typeof meta.movedAt === 'string' ? meta.movedAt : '',
        })
      } catch {
        // 坏回收站条目不阻塞列表。
      }
    }
    return out.sort((a, b) => b.movedAt.localeCompare(a.movedAt))
  }

  async restore(id: string, to?: string): Promise<void> {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`invalid trash id: ${id}`)
    const dir = join(this.root, 'detail', TRASH_DIR, id)
    const metaPath = join(dir, TRASH_META)
    if (!existsSync(metaPath)) throw new Error(`trash entry not found: ${id}`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { original?: unknown }
    if (typeof meta.original !== 'string') throw new Error(`trash entry has no original path: ${id}`)
    const destination = this.resolve(to ?? meta.original)
    if (destination.readOnly) throw new Error('memory library path is read-only')
    if (existsSync(destination.abs)) throw new Error(`restore target already exists: ${destination.path}`)
    const item = join(dir, basename(meta.original))
    if (!existsSync(item)) throw new Error(`trash payload not found: ${id}`)
    rejectSymlink(item)
    await this.locked(async () => {
      mkdirSync(dirname(destination.abs), { recursive: true })
      renameSync(item, destination.abs)
      rmSync(dir, { recursive: true, force: true })
      this.changed([destination.area])
    })
  }

  private resolve(path: string): ResolvedPath {
    if (path.length === 0 || path.startsWith('/') || path.includes('\\')) {
      throw new Error(`invalid memory library path: ${path}`)
    }
    const parts = path.split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || isHiddenName(part))) {
      throw new Error(`invalid memory library path: ${path}`)
    }
    if (parts[0] === 'log' || parts[0] === '.state' || parts[0] === '.git') {
      throw new Error(`memory library path is read-only/system: ${path}`)
    }

    const first = parts[0]!
    if (AREAS.has(first as MemoryLibraryArea)) {
      const area = first as MemoryLibraryArea
      const rest = parts.slice(1)
      if (rest.length === 0) throw new Error(`memory library area needs a file: ${path}`)
      if (rest.some(part => isProtectedMemorySegment(part))) {
        throw new Error(`protected memory library path: ${path}`)
      }
      const abs = assertWithin(
        this.root,
        join(this.root, area, ...rest),
        'memory library path',
      )
      const readOnly = area === 'proposals'
        || (area === 'agents' && rest[rest.length - 1] === 'agent.json')
      let target: string | undefined
      if (area === 'detail' && rest.length >= 2 && rest[rest.length - 1]!.endsWith('.json')) {
        target = parseDetailTarget(this.root, `detail:${rest.slice(0, -1).join('/')}/${rest[rest.length - 1]!.slice(0, -'.json'.length)}`).target
      }
      return { path: parts.join('/'), area, parts, abs, readOnly, ...(target ? { target } : {}) }
    }

    if (parts.length !== 1 || !ROOT_ALLOWED.test(first) || first === 'indexlist.json') {
      throw new Error(`unknown memory library path: ${path}`)
    }
    if (isProtectedMemorySegment(first)) throw new Error(`protected memory library path: ${path}`)
    const abs = assertWithin(this.root, join(this.root, first), 'memory library path')
    return {
      path: first,
      area: 'root',
      parts,
      abs,
      readOnly: ROOT_READ_ONLY.has(first),
    }
  }

  private walk(area: MemoryLibraryArea, dir: string, out: MemoryLibraryNode[]): void {
    const summaryMap = new Map<string, MemoryLibraryNode>()
    if (area === 'detail') {
      for (const summary of this.store.listDocuments({ includePrivate: true, includeInvalid: true })) {
        summaryMap.set(summary.target!, {
          path: `detail/${summary.namespace}/${summary.filename}.json`,
          name: `${summary.filename}.json`,
          kind: 'file',
          area,
          readOnly: false,
          target: summary.target!,
          ...(summary.private ? { private: true } : {}),
          ...(summary.invalid ? { invalid: summary.invalid } : {}),
          entries: summary.entries,
          bytes: summary.bytes,
          updatedAt: summary.updatedAt,
        })
      }
    }

    const walkDir = (current: string): void => {
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (isHiddenName(entry.name) || entry.name === TRASH_DIR || entry.name === '_archive') continue
        const abs = join(current, entry.name)
        const rel = slash(relative(this.root, abs))
        const parts = rel.split('/')
        if (entry.isDirectory()) {
          out.push({
            path: rel,
            name: entry.name,
            kind: 'directory',
            area,
            readOnly: area === 'proposals',
            ...(area === 'detail' && parts.some(part => part.startsWith('_')) ? { private: true } : {}),
          })
          walkDir(abs)
        } else if (entry.isFile()) {
          if (entry.name === 'indexlist.json') continue
          if (area === 'detail' && !entry.name.endsWith('.json')) continue
          const known = summaryMap.get(this.detailTargetOf(rel))
          if (known) {
            out.push(known)
            continue
          }
          const stamp = fileStamp(abs)
          out.push({
            path: rel,
            name: entry.name,
            kind: 'file',
            area,
            readOnly: area === 'proposals'
              || (area === 'agents' && entry.name === 'agent.json'),
            ...stamp,
            ...(area === 'detail' ? { invalid: 'not a valid memory file' } : {}),
          })
        }
      }
    }

    out.push({
      path: area,
      name: area,
      kind: 'directory',
      area,
      readOnly: area === 'proposals' || area === 'agents',
    })
    walkDir(dir)
  }

  private detailTargetOf(path: string): string {
    const body = path.slice('detail/'.length).replace(/\.json$/i, '')
    return `detail:${body}`
  }

  private rootFiles(out: MemoryLibraryNode[]): void {
    for (const name of readdirSync(this.root, { withFileTypes: true })) {
      if (!name.isFile() || !ROOT_ALLOWED.test(name.name) || name.name === 'indexlist.json') continue
      if (isHiddenName(name.name) && !name.name.startsWith('_')) continue
      const abs = join(this.root, name.name)
      const stamp = fileStamp(abs)
      out.push({
        path: name.name,
        name: name.name,
        kind: 'file',
        area: 'root',
        readOnly: ROOT_READ_ONLY.has(name.name),
        ...stamp,
      })
    }
  }

  private async locked<T>(task: () => Promise<T> | T): Promise<T> {
    const run = (): Promise<T> => {
      mkdirSync(dirname(this.lockPath), { recursive: true })
      return withFileLock(this.lockPath, task, { timeoutMs: 15_000 })
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private changed(paths: readonly string[]): void {
    this.onChange?.(paths)
  }

  private updateProposalTargets(oldTarget: string, newTarget: string): void {
    const dir = join(this.root, 'proposals')
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(dir, entry.name)
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as {
          kind?: unknown
          target?: unknown
        }
        if (raw.kind !== 'detail' || typeof raw.target !== 'string') continue
        if (!raw.target.startsWith(oldTarget)) continue
        raw.target = `${newTarget}${raw.target.slice(oldTarget.length)}`
        atomicWrite(path, `${JSON.stringify(raw, null, 2)}\n`)
      } catch {
        // 坏 proposal 不阻塞移动。
      }
    }
  }

  private trashPath(ref: ResolvedPath): void {
    const id = randomUUID()
    const dir = join(this.root, 'detail', TRASH_DIR, id)
    mkdirSync(dir, { recursive: true })
    const name = basename(ref.abs)
    const item = join(dir, name)
    renameSync(ref.abs, item)
    const meta = {
      original: ref.path,
      name,
      kind: isDirectory(item) ? 'directory' : 'file',
      movedAt: new Date().toISOString(),
    }
    atomicWrite(join(dir, TRASH_META), `${JSON.stringify(meta, null, 2)}\n`)
  }
}
