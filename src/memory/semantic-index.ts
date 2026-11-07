/**
 * 语义检索索引：把 detail 条目向量化，查询时做余弦召回。
 *
 * 它和 FTS 索引并列，都是 detail 的投影；没有启用本地模型时完全不用。
 *
 * @module if/memory/semantic-index
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemorySearchHit, MemoryStore, MemoryTag } from './store.ts'

export interface MemoryEmbedder {
  isAvailable(): boolean
  modelId(): string | undefined
  embedQuery(text: string): Promise<Float32Array>
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>
}

export interface SemanticSearchOptions {
  readonly limit?: number
  readonly domain?: string
  readonly tag?: MemoryTag
}

export interface SemanticIndexStatus {
  readonly ready: boolean
  readonly building: boolean
  readonly modelId?: string
  readonly entries: number
  readonly error?: string
}

const PREVIEW_CHARS = 240

function hit(tag: string, content: string, target: string, id: string, filename: string): MemorySearchHit {
  return {
    target,
    id,
    tag: (tag === '确信' || tag === '可信' || tag === '有疑' ? tag : '有疑') as MemoryTag,
    preview: content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content,
    filename,
  }
}

export class SemanticMemoryIndex {
  readonly root: string
  readonly dbPath: string
  private readonly store: MemoryStore
  private readonly embedder: MemoryEmbedder
  private db?: DatabaseSync
  private dirty = true
  private building?: Promise<void>
  private lastError?: string

  constructor(
    root: string,
    store: MemoryStore,
    embedder: MemoryEmbedder,
    dbPath = join(root, '.state', 'semantic.sqlite'),
  ) {
    this.root = root
    this.store = store
    this.embedder = embedder
    this.dbPath = dbPath
  }

  markDirty(): void {
    this.dirty = true
  }

  status(): SemanticIndexStatus {
    const modelId = this.embedder.modelId()
    const entries = this.db && !this.dirty ? this.count() : 0
    return {
      ready: Boolean(
        this.db
        && !this.dirty
        && modelId
        && this.meta('modelId') === modelId
        && this.embedder.isAvailable(),
      ),
      building: Boolean(this.building),
      ...(modelId ? { modelId } : {}),
      entries,
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  /** 供 App/UI 在后台触发；失败留在 lastError，不阻塞会话。 */
  build(): Promise<void> {
    return this.ensureBuilt()
  }

  async search(query: string, options: SemanticSearchOptions = {}): Promise<MemorySearchHit[]> {
    if (!this.embedder.isAvailable()) throw new Error('embedding model is not activated')
    if (query.trim().length === 0) return []
    await this.ensureBuilt()
    const db = this.db!
    const vector = await this.embedder.embedQuery(query)
    const filters: string[] = []
    const params: string[] = []
    if (options.domain) {
      filters.push('domain = ?')
      params.push(options.domain)
    }
    if (options.tag) {
      filters.push('tag = ?')
      params.push(options.tag)
    }
    const rows = db.prepare(`
      SELECT target, entry_id, filename, tag, content, vector
      FROM vectors
      ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
    `).all(...params) as Record<string, unknown>[]

    const scored: { score: number; hit: MemorySearchHit }[] = []
    for (const row of rows) {
      const buffer = row.vector
      if (!(buffer instanceof Uint8Array)) continue
      const other = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
      let score = 0
      const length = Math.min(vector.length, other.length)
      for (let i = 0; i < length; i += 1) score += vector[i]! * other[i]!
      scored.push({
        score,
        hit: hit(
          String(row.tag ?? ''),
          String(row.content ?? ''),
          String(row.target ?? ''),
          String(row.entry_id ?? ''),
          String(row.filename ?? ''),
        ),
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(1, Math.min(options.limit ?? 20, 100))).map(item => item.hit)
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  private async ensureBuilt(): Promise<void> {
    if (this.building) return this.building
    const modelId = this.embedder.modelId()
    if (!modelId) throw new Error('embedding model is not activated')
    this.open()
    const current = this.meta('modelId')
    if (!this.dirty && current === modelId && this.count() > 0) return
    this.building = this.rebuild(modelId)
    try {
      await this.building
      this.dirty = false
      this.lastError = undefined
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.building = undefined
    }
  }

  private async rebuild(modelId: string): Promise<void> {
    const db = this.db!
    const docs = this.store.listDocuments({ includePrivate: false, includeInvalid: false })
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM vectors')
      const insert = db.prepare(`
        INSERT INTO vectors (key, target, entry_id, domain, filename, tag, content, vector, dim)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const summary of docs) {
        let doc
        try {
          doc = this.store.read(summary.target)
        } catch {
          continue
        }
        for (const entry of doc.entries) {
          const text = [entry.content, ...(entry.quotes ?? []).map(quote => quote.say)].join('\n')
          const vector = await this.embedder.embedDocuments([text])
          const embedding = vector[0]
          if (!embedding) continue
          insert.run(
            `${summary.target}#${entry.id}`,
            summary.target,
            entry.id,
            summary.domain,
            summary.filename,
            entry.tag,
            entry.content,
            Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            embedding.length,
          )
        }
      }
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('modelId', modelId)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 已经回滚
      }
      throw error
    }
  }

  private open(): void {
    if (this.db) return
    mkdirSync(join(this.root, '.state'), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors (
        key TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        filename TEXT NOT NULL,
        tag TEXT NOT NULL,
        content TEXT NOT NULL,
        vector BLOB NOT NULL,
        dim INTEGER NOT NULL
      );
    `)
    this.dirty = true
  }

  private count(): number {
    if (!this.db) return 0
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  private meta(key: string): string | undefined {
    if (!this.db) return undefined
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value
  }
}
