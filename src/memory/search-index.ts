/**
 * detail 的本地检索索引：SQLite FTS5 trigram，中文按子串召回。
 *
 * 它只是 detail 的投影，不存第二份记忆；写入后标脏，下次查询重建。
 *
 * @module if/memory/search-index
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemorySearchHit, MemoryStore, MemoryTag } from './store.ts'

export interface MemorySearchOptions {
  readonly limit?: number
  readonly domain?: string
  readonly tag?: MemoryTag
}

const PREVIEW_CHARS = 240

function clampLimit(value: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(value ?? 20), 100))
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`
}

function rowToHit(row: Record<string, unknown>): MemorySearchHit {
  const content = typeof row.content === 'string' ? row.content : ''
  return {
    target: String(row.target ?? ''),
    id: String(row.entry_id ?? ''),
    tag: (row.tag === '确信' || row.tag === '可信' || row.tag === '有疑'
      ? row.tag
      : '有疑') as MemoryTag,
    preview: content.length > PREVIEW_CHARS
      ? `${content.slice(0, PREVIEW_CHARS)}…`
      : content,
    filename: String(row.filename ?? ''),
  }
}

export class MemorySearchIndex {
  readonly root: string
  readonly dbPath: string
  private readonly store: MemoryStore
  private db?: DatabaseSync
  private dirty = true
  private signature = ''

  constructor(root: string, store: MemoryStore, dbPath = join(root, '.state', 'search.sqlite')) {
    this.root = root
    this.store = store
    this.dbPath = dbPath
  }

  markDirty(): void {
    this.dirty = true
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchHit[] {
    const needle = query.trim()
    if (needle.length === 0) return []
    this.ensure()
    const db = this.db!
    const limit = clampLimit(options.limit)

    if (needle.length < 3) {
      return this.searchLike(db, needle, options, limit)
    }

    const filters: string[] = []
    const params: (string | number)[] = [`"${needle.replace(/"/g, '""')}"`]
    if (options.domain) {
      filters.push('domain = ?')
      params.push(options.domain)
    }
    if (options.tag) {
      filters.push('tag = ?')
      params.push(options.tag)
    }
    try {
      const rows = db.prepare(`
        SELECT target, entry_id, domain, filename, tag, at, content, quotes
        FROM entries
        WHERE entries MATCH ?${filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''}
        ORDER BY rank
        LIMIT ?
      `).all(...params, limit) as Record<string, unknown>[]
      return rows.map(rowToHit)
    } catch {
      // FTS 查询语法/分词失败时退回子串匹配，不让一次搜索把整轮卡死。
      return this.searchLike(db, needle, options, limit)
    }
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  private ensure(): void {
    if (!this.db) {
      mkdirSync(join(this.root, '.state'), { recursive: true })
      this.db = new DatabaseSync(this.dbPath)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
          target UNINDEXED,
          entry_id UNINDEXED,
          domain UNINDEXED,
          filename UNINDEXED,
          tag UNINDEXED,
          at UNINDEXED,
          content,
          quotes,
          tokenize='trigram'
        )
      `)
      this.dirty = true
    }
    const signature = this.store.listDocuments({
      includePrivate: false,
      includeInvalid: false,
    }).map(item => `${item.target}:${item.updatedAt}:${item.bytes}:${item.entries}`).join('\n')
    if (signature !== this.signature) {
      this.signature = signature
      this.dirty = true
    }
    if (this.dirty) this.rebuild()
  }

  private rebuild(): void {
    const db = this.db!
    const docs = this.store.listDocuments({ includePrivate: false, includeInvalid: false })
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM entries')
      const insert = db.prepare(`
        INSERT INTO entries (
          target, entry_id, domain, filename, tag, at, content, quotes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const summary of docs) {
        let doc
        try {
          doc = this.store.read(summary.target)
        } catch {
          continue
        }
        for (const entry of doc.entries) {
          insert.run(
            summary.target,
            entry.id,
            summary.domain,
            summary.filename,
            entry.tag,
            entry.at ?? '',
            entry.content,
            (entry.quotes ?? []).map(quote => quote.say).join('\n'),
          )
        }
      }
      db.exec('COMMIT')
      this.dirty = false
      this.signature = docs.map(item => `${item.target}:${item.updatedAt}:${item.bytes}:${item.entries}`).join('\n')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 已经回滚过
      }
      throw error
    }
  }

  private searchLike(
    db: DatabaseSync,
    needle: string,
    options: MemorySearchOptions,
    limit: number,
  ): MemorySearchHit[] {
    const filters = [
      "(content LIKE ? ESCAPE '\\' OR quotes LIKE ? ESCAPE '\\' OR entry_id LIKE ? ESCAPE '\\')",
    ]
    const pattern = likePattern(needle)
    const params: (string | number)[] = [pattern, pattern, pattern]
    if (options.domain) {
      filters.push('domain = ?')
      params.push(options.domain)
    }
    if (options.tag) {
      filters.push('tag = ?')
      params.push(options.tag)
    }
    params.push(limit)
    const rows = db.prepare(`
      SELECT target, entry_id, domain, filename, tag, at, content, quotes
      FROM entries
      WHERE ${filters.join(' AND ')}
      LIMIT ?
    `).all(...params) as Record<string, unknown>[]
    return rows.map(rowToHit)
  }
}
