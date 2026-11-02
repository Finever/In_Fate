import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MainAgentIdentity } from '../types'

export function IdentityEditor({ agentId }: { agentId: string }) {
  const [identity, setIdentity] = useState<MainAgentIdentity>()
  const [slotId, setSlotId] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setNotice(undefined)
    void api.mainAgentIdentity(agentId)
      .then(data => {
        if (cancelled) return
        setIdentity(data)
        const first = data.slots[0]
        setSlotId(first?.id ?? '')
        setDraft(first?.content ?? '')
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

  const slot = identity?.slots.find(item => item.id === slotId)
  const dirty = Boolean(slot && draft !== slot.content)

  function selectSlot(nextId: string): void {
    const next = identity?.slots.find(item => item.id === nextId)
    setSlotId(nextId)
    setDraft(next?.content ?? '')
    setNotice(undefined)
  }

  async function save(): Promise<void> {
    if (!slot || !dirty || saving) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.writeMainAgentSlot(agentId, slot.id, draft)
      setIdentity(current => current
        ? {
          ...current,
          slots: current.slots.map(item =>
            item.id === slot.id ? { ...item, content: draft } : item),
        }
        : current)
      setNotice(result.backup ? '已保存，旧文件已备份' : '已保存')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="fw-panel-loading"><span className="fw-spinner" /> 载入身份…</div>
  }

  if (error && !identity) {
    return <div className="fw-panel-error">{error}</div>
  }

  if (!identity || identity.slots.length === 0) {
    return <div className="fw-panel-empty">这个 agent 没有可编辑的身份文件。</div>
  }

  return (
    <div className="fw-identity">
      <div className="fw-slot-tabs">
        {identity.slots.map(item => (
          <button
            key={item.id}
            type="button"
            className={item.id === slotId ? 'is-active' : ''}
            onClick={() => selectSlot(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {slot && (
        <>
          <code className="fw-slot-path" title={slot.path}>{slot.file}</code>
          <textarea
            className="fw-identity-text"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
            aria-label={`${slot.label} 文件内容`}
          />
          <div className="fw-editor-foot">
            <span className={dirty ? 'is-dirty' : ''}>
              {dirty ? '有未保存修改' : notice ?? ''}
            </span>
            <button
              type="button"
              className="fw-editor-save"
              onClick={() => void save()}
              disabled={!dirty || saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
          {error && <div className="fw-panel-error">{error}</div>}
        </>
      )}
    </div>
  )
}
