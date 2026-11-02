import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { oneLine } from '../lib/format'
import type { MemoryDocument, MemoryProposal, MemorySearchHit } from '../types'

export function MemoryPanel() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [document, setDocument] = useState<MemoryDocument>()
  const [proposals, setProposals] = useState<MemoryProposal[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  const loadProposals = useCallback(async (): Promise<void> => {
    try {
      setProposals(await api.memoryProposals('pending'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    void loadProposals()
  }, [loadProposals])

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

  async function respond(proposal: MemoryProposal, accept: boolean): Promise<void> {
    setBusyId(proposal.proposalId)
    setError(undefined)
    try {
      if (accept) await api.acceptProposal(proposal.proposalId)
      else await api.rejectProposal(proposal.proposalId)
      setProposals(current => current.filter(item => item.proposalId !== proposal.proposalId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyId(undefined)
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

      <section className="fw-memory-proposals">
        <div className="fw-memory-section-head">
          <span>待处理提议</span>
          <b>{proposals.length}</b>
        </div>
        {proposals.length === 0 && <div className="fw-panel-empty">没有待处理提议。</div>}
        {proposals.map(proposal => (
          <article key={proposal.proposalId} className="fw-proposal">
            <div className="fw-proposal-head">
              <span>{proposal.kind === 'detail' ? proposal.target : `identity:${proposal.identity?.file ?? ''}`}</span>
              <em>{proposal.status}</em>
            </div>
            <p>
              {proposal.kind === 'detail'
                ? proposal.entry?.content
                : proposal.identity
                  ? `## ${proposal.identity.section}\n${proposal.identity.content}`
                  : ''}
            </p>
            {proposal.reason && <small>{proposal.reason}</small>}
            <div className="fw-proposal-actions">
              <button
                type="button"
                disabled={busyId === proposal.proposalId}
                onClick={() => void respond(proposal, false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={busyId === proposal.proposalId}
                onClick={() => void respond(proposal, true)}
              >
                接受
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}
