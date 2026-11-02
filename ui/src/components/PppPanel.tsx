import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MainAgentIdentity } from '../types'
import { Icon } from './Icon'

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim().length > 0)?.slice(0, 100) ?? '（空文件）'
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function PppPanel({ agentId }: { agentId: string }) {
  const [identity, setIdentity] = useState<MainAgentIdentity>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [confirming, setConfirming] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setNotice(undefined)
    setIdentity(undefined)
    setOpen({})
    setDrafts({})
    setBusy(undefined)
    setConfirming(undefined)
    void api.mainAgentIdentity(agentId)
      .then(next => {
        if (!cancelled) setIdentity(next)
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  async function save(slotId: string): Promise<void> {
    if (confirming !== slotId) {
      setConfirming(slotId)
      return
    }
    const content = drafts[slotId]
    if (content === undefined) return
    setBusy(slotId)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.writeMainAgentSlot(agentId, slotId, content)
      setIdentity(current => current
        ? {
          ...current,
          slots: current.slots.map(slot =>
            slot.id === slotId ? { ...slot, content } : slot),
        }
        : current)
      setDrafts(current => {
        const next = { ...current }
        delete next[slotId]
        return next
      })
      setConfirming(undefined)
      setNotice(`已保存 · 备份 ${result.backup}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  if (loading) {
    return <div className="fw-panel-loading"><span className="fw-spinner" /> 载入 PPP…</div>
  }

  return (
    <div className="fw-ppp-panel">
      <div className="fw-ppp-intro">
        <span>PPP 文件</span>
        <small>原则 / 偏好 / 当口。保存会覆盖原文件，先自动备份到 _archive。</small>
      </div>

      {error && <div className="fw-dialog-error fw-status-error">{error}</div>}
      {notice && <div className="fw-settings-notice fw-ppp-notice" title={notice}>{notice}</div>}

      {!identity && (
        <div className="fw-panel-empty">没有读到 PPP 文件。</div>
      )}

      {identity?.slots.map(slot => {
        const openSlot = Boolean(open[slot.id])
        const draft = drafts[slot.id] ?? slot.content
        const dirty = draft !== slot.content
        const confirmingSlot = confirming === slot.id
        return (
          <div className="fw-status-ppp" key={slot.id}>
            <button
              type="button"
              className="fw-status-ppp-head"
              aria-expanded={openSlot}
              onClick={() => setOpen(current => ({
                ...current,
                [slot.id]: !openSlot,
              }))}
            >
              <span className="fw-status-ppp-label">
                {slot.label}
                {dirty && <em className="fw-ppp-dirty">未保存</em>}
              </span>
              <span className="fw-status-ppp-path" title={slot.path}>{slot.path}</span>
              <span className="fw-status-ppp-preview">{firstLine(draft)}</span>
              <Icon name="down" size={13} className={openSlot ? 'is-open' : ''} />
            </button>

            {openSlot && (
              <div className="fw-status-ppp-body">
                {slot.description && (
                  <p className="fw-ppp-description">{slot.description}</p>
                )}
                <textarea
                  value={draft}
                  spellCheck={false}
                  onChange={event => {
                    const value = event.target.value
                    setDrafts(current => ({ ...current, [slot.id]: value }))
                    setConfirming(undefined)
                    setNotice(undefined)
                  }}
                />
                <div className="fw-ppp-meta">
                  <span>{byteLength(draft).toLocaleString('en-US')} 字节</span>
                  {dirty && (
                    <button
                      type="button"
                      className="fw-status-link"
                      onClick={() => {
                        setDrafts(current => {
                          const next = { ...current }
                          delete next[slot.id]
                          return next
                        })
                        setConfirming(undefined)
                      }}
                    >
                      还原
                    </button>
                  )}
                </div>
                {confirmingSlot && (
                  <div className="fw-ppp-confirm">
                    确认覆盖这个文件？原文件会先备份到 _archive。
                  </div>
                )}
                <div className="fw-status-ppp-actions">
                  <span>{dirty ? '有未保存的改动' : '已保存'}</span>
                  <div className="fw-ppp-actions-right">
                    {confirmingSlot && (
                      <button
                        type="button"
                        className="fw-dialog-cancel fw-ppp-cancel"
                        onClick={() => setConfirming(undefined)}
                      >
                        取消
                      </button>
                    )}
                    <button
                      type="button"
                      className="fw-status-save"
                      onClick={() => void save(slot.id)}
                      disabled={busy === slot.id || !dirty}
                    >
                      {busy === slot.id
                        ? '保存中…'
                        : confirmingSlot ? '确认保存' : '保存'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
