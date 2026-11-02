import { useEffect, useState } from 'react'
import { api } from '../api'
import { oneLine } from '../lib/format'
import { Markdown } from '../lib/markdown'
import type { MemoryDocument, MemoryEntry, MemorySearchHit } from '../types'
import { Icon } from './Icon'

const PAGE_SIZE = 20
const SEARCH_LIMIT = 50

function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
}

function Quotes({ entry }: { entry: MemoryEntry }) {
  if (!entry.quotes || entry.quotes.length === 0) return null
  return (
    <details className="fw-mem-quotes">
      <summary>原话 · {entry.quotes.length} 条</summary>
      {entry.quotes.map((quote, index) => (
        <blockquote key={`${quote['log-addr'] ?? quote.say}-${index}`}>
          <p>{quote.say}</p>
          <footer>
            {quote.at && <span>{quote.at}</span>}
            {quote.tag?.map(tag => <em key={tag}>{tag}</em>)}
            {quote['log-addr'] && <code>{quote['log-addr']}</code>}
          </footer>
        </blockquote>
      ))}
    </details>
  )
}

export function MemoryBrowser() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [doc, setDoc] = useState<MemoryDocument>()
  const [focusId, setFocusId] = useState<string>()
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!doc || !focusId) return
    const node = window.document.getElementById(`mem-entry-${focusId}`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [doc, focusId])

  async function search(): Promise<void> {
    const needle = query.trim()
    if (!needle) {
      setError('先输入关键词再搜索。')
      return
    }
    setLoading(true)
    setError(undefined)
    setDoc(undefined)
    setFocusId(undefined)
    setVisible(PAGE_SIZE)
    try {
      setHits(await api.memorySearch(needle, SEARCH_LIMIT))
      setSearched(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  async function openHit(hit: MemorySearchHit): Promise<void> {
    setLoading(true)
    setError(undefined)
    setFocusId(hit.id)
    try {
      const next = await api.memoryRead(hit.target)
      setDoc(next)
      const index = next.entries.findIndex(entry => entry.id === hit.id)
      setVisible(index >= 0 ? Math.max(PAGE_SIZE, index + 1) : PAGE_SIZE)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const entries = doc ? doc.entries.slice(0, visible) : []
  const remaining = doc ? doc.entries.length - entries.length : 0

  return (
    <div className="fw-mem">
      <form
        className="fw-mem-search"
        onSubmit={event => {
          event.preventDefault()
          void search()
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索全局 detail 记忆"
          aria-label="搜索全局记忆"
        />
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </form>

      {error && <div className="fw-dialog-error fw-mem-error">{error}</div>}

      {doc && (
        <div className="fw-mem-doc-bar">
          {searched && (
            <button
              type="button"
              className="fw-status-link"
              onClick={() => {
                setDoc(undefined)
                setFocusId(undefined)
              }}
            >
              ← 返回结果
            </button>
          )}
          <b>{doc.filename}</b>
          <span>{doc.project}</span>
          <em>{doc.entries.length} 条</em>
        </div>
      )}

      <div className="fw-mem-scroll">
        {!searched && !doc && (
          <div className="fw-mem-empty">
            <Icon name="search" size={22} />
            <b>全局记忆</b>
            <span>搜索所有 agent 共享的 detail 记忆库。</span>
            <small>这里只读。人格文件在右栏「人格文件」，记忆提议在审批弹窗处理。</small>
          </div>
        )}

        {searched && !doc && (
          <div className="fw-mem-results">
            <div className="fw-mem-result-head">
              <span>找到 {hits.length} 条</span>
              <small>detail 记忆库 · 全局共享 · 最多 {SEARCH_LIMIT} 条</small>
            </div>
            {hits.length === 0 && (
              <div className="fw-mem-empty">
                <span>没有匹配的记忆。</span>
                <small>换个关键词试试；空查询不会搜索。</small>
              </div>
            )}
            {hits.map(hit => (
              <button
                key={`${hit.target}#${hit.id}`}
                type="button"
                className="fw-mem-hit"
                onClick={() => void openHit(hit)}
              >
                <span className="fw-mem-hit-head">
                  <b>{hit.filename}</b>
                  <em className="fw-tag" data-tag={hit.tag}>{hit.tag}</em>
                </span>
                <span className="fw-mem-hit-target">{hit.target}</span>
                <span className="fw-mem-hit-preview">
                  {oneLine(plainPreview(hit.preview), 200)}
                </span>
              </button>
            ))}
          </div>
        )}

        {doc && (
          <div className="fw-mem-doc">
            {doc.introduction && <p className="fw-mem-intro">{doc.introduction}</p>}

            {entries.map(entry => (
              <article
                key={entry.id}
                id={`mem-entry-${entry.id}`}
                className={`fw-mem-entry${entry.id === focusId ? ' is-focus' : ''}`}
              >
                <div className="fw-mem-entry-head">
                  <span>{entry.id}</span>
                  <em className="fw-tag" data-tag={entry.tag}>{entry.tag}</em>
                  {entry.at && <small>{entry.at}</small>}
                </div>
                <div className="fw-mem-entry-body">
                  <Markdown text={entry.content} />
                </div>
                <Quotes entry={entry} />
              </article>
            ))}

            {remaining > 0 && (
              <button
                type="button"
                className="fw-mem-more"
                onClick={() => setVisible(value => value + PAGE_SIZE)}
              >
                加载更多 · 还剩 {remaining} 条
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
