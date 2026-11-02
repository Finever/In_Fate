import { useState } from 'react'
import { api } from '../api'
import { oneLine } from '../lib/format'
import type { MemoryDocument, MemorySearchHit } from '../types'

export function MemoryPanel() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [document, setDocument] = useState<MemoryDocument>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  async function search(): Promise<void> {
    setLoading(true)
    setError(undefined)
    setDocument(undefined)
    try {
      setHits(await api.memorySearch(query.trim()))
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
    try {
      setDocument(await api.memoryRead(hit.target))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fw-memory">
      <form
        className="fw-memory-search"
        onSubmit={event => {
          event.preventDefault()
          void search()
        }}
      >
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索记忆"
          aria-label="搜索记忆"
        />
        <button type="submit" disabled={loading}>搜索</button>
      </form>

      {error && <div className="fw-panel-error">{error}</div>}

      {searched && (
        <div className="fw-memory-hits">
          {hits.length === 0 && <div className="fw-panel-empty">没有匹配的记忆。</div>}
          {hits.map(hit => (
            <button
              key={`${hit.target}#${hit.id}`}
              type="button"
              className="fw-memory-hit"
              onClick={() => void openHit(hit)}
            >
              <span className="fw-memory-hit-head">
                <b>{hit.filename}</b>
                <em className="fw-tag" data-tag={hit.tag}>{hit.tag}</em>
              </span>
              <span>{oneLine(hit.preview, 160)}</span>
            </button>
          ))}
        </div>
      )}

      {document && (
        <section className="fw-memory-doc">
          <div className="fw-memory-doc-head">
            <b>{document.filename}</b>
            <span>{document.project}</span>
          </div>
          {document.introduction && <p>{document.introduction}</p>}
          {document.entries.map(entry => (
            <article key={entry.id} className="fw-memory-entry">
              <div className="fw-memory-entry-head">
                <span>{entry.id}</span>
                <em className="fw-tag" data-tag={entry.tag}>{entry.tag}</em>
              </div>
              <p>{entry.content}</p>
            </article>
          ))}
        </section>
      )}

    </div>
  )
}
