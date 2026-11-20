import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MainAgentIdentity, MainAgentIdentityBackup } from '../types'
import { Icon } from './Icon'

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim().length > 0)?.slice(0, 100) ?? '（空文件）'
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function PersonaPanel({ agentId }: { agentId: string }) {
  const [identity, setIdentity] = useState<MainAgentIdentity>()
  const [backups, setBackups] = useState<MainAgentIdentityBackup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [confirming, setConfirming] = useState<string>()
  const [showBackups, setShowBackups] = useState(false)
  const [restoring, setRestoring] = useState<string>()

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
    setShowBackups(false)
    setRestoring(undefined)
    void Promise.all([
      api.mainAgentIdentity(agentId),
      api.mainAgentIdentityBackups(agentId),
    ])
      .then(([next, nextBackups]) => {
        if (cancelled) return
        setIdentity(next)
        setBackups(nextBackups)
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
      setNotice(`已保存 · 下一轮对话生效 · 备份 ${result.backup}`)
      void api.mainAgentIdentityBackups(agentId).then(setBackups).catch(() => undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function restore(file: string): Promise<void> {
    if (!window.confirm(`恢复这份人格备份？\n\n${file}\n\n当前版本会先自动备份。`)) return
    setRestoring(file)
    setError(undefined)
    setNotice(undefined)
    try {
      await api.restoreMainAgentIdentity(agentId, file)
      const [next, nextBackups] = await Promise.all([
        api.mainAgentIdentity(agentId),
        api.mainAgentIdentityBackups(agentId),
      ])
      setIdentity(next)
      setBackups(nextBackups)
      setDrafts({})
      setNotice('已恢复 · 下一轮对话生效')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRestoring(undefined)
    }
  }

  if (loading) {
    return <div className="fw-panel-loading"><span className="fw-spinner" /> 载入人格文件…</div>
  }

  return (
    <div className="fw-persona-panel">
      <div className="fw-persona-intro">
        <span>人格文件</span>
        <small>原则 / 偏好 / 提示。保存会覆盖原文件，先自动备份到 _archive；下一轮对话生效。</small>
      </div>

      <div className="fw-persona-backups">
        <button
          type="button"
          className="fw-persona-backups-toggle"
          onClick={() => setShowBackups(value => !value)}
        >
          <span>历史备份</span>
          <small>{backups.length}</small>
          <Icon name="down" size={12} className={showBackups ? 'is-open' : ''} />
        </button>
        {showBackups && (
          <div className="fw-persona-backup-list">
            {backups.length === 0 && (
              <div className="fw-panel-empty">还没有可恢复的备份。</div>
            )}
            {backups.map(backup => (
              <div className="fw-persona-backup-row" key={backup.file}>
                <span>
                  <b>
                    {identity?.manifest.identity.find(slot => slot.id === backup.slot)?.label
                      ?? backup.slot}
                  </b>
                  <small>{new Date(backup.updatedAt).toLocaleString('zh-CN')}</small>
                </span>
                <small>{Math.ceil(backup.bytes / 1024)} KB</small>
                <button
                  type="button"
                  className="fw-status-link"
                  disabled={Boolean(restoring)}
                  onClick={() => void restore(backup.file)}
                >
                  {restoring === backup.file ? '恢复中…' : '恢复'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="fw-dialog-error fw-status-error">{error}</div>}
      {notice && <div className="fw-settings-notice fw-persona-notice" title={notice}>{notice}</div>}

      {!identity && (
        <div className="fw-panel-empty">没有读到 人格文件。</div>
      )}

      {identity?.slots.map(slot => {
        const openSlot = Boolean(open[slot.id])
        const draft = drafts[slot.id] ?? slot.content
        const dirty = draft !== slot.content
        const confirmingSlot = confirming === slot.id
        return (
          <div className="fw-persona-slot" key={slot.id}>
            <button
              type="button"
              className="fw-persona-slot-head"
              aria-expanded={openSlot}
              onClick={() => setOpen(current => ({
                ...current,
                [slot.id]: !openSlot,
              }))}
            >
              <span className="fw-persona-slot-label">
                {slot.label}
                {dirty && <em className="fw-persona-dirty">未保存</em>}
              </span>
              <span className="fw-persona-slot-path" title={slot.path}>{slot.path}</span>
              <span className="fw-persona-slot-preview">{firstLine(draft)}</span>
              <Icon name="down" size={13} className={openSlot ? 'is-open' : ''} />
            </button>

            {openSlot && (
              <div className="fw-persona-slot-body">
                {slot.description && (
                  <p className="fw-persona-description">{slot.description}</p>
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
                <div className="fw-persona-meta">
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
                  <div className="fw-persona-confirm">
                    确认覆盖这个文件？原文件会先备份到 _archive。
                  </div>
                )}
                <div className="fw-persona-slot-actions">
                  <span>{dirty ? '有未保存的改动' : '已保存'}</span>
                  <div className="fw-persona-actions-right">
                    {confirmingSlot && (
                      <button
                        type="button"
                        className="fw-dialog-cancel fw-persona-cancel"
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
