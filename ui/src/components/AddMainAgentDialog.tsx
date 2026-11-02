import { useEffect, useState } from 'react'
import { Icon } from './Icon'

export function AddMainAgentDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (input: { id: string; name: string }) => Promise<void>
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const canSubmit = Boolean(id.trim() && name.trim() && !busy)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit({ id: id.trim(), name: name.trim() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fw-modal-backdrop"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="fw-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="添加主 agent"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <h2>添加主 agent</h2>
          <button
            type="button"
            className="fw-icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            title="关闭"
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <label className="fw-field">
          <span>id</span>
          <input
            autoFocus
            value={id}
            onChange={event => setId(event.target.value)}
            placeholder="例如 main / example-agent"
            disabled={busy}
            spellCheck={false}
          />
          <small>会作为记忆目录名，创建后不改。</small>
          {id.trim() === 'main' && (
            <small className="fw-dialog-warn">
              main 也是旧会话的回退身份；先写好人格文件再聊，避免旧会话读到空白身份。
            </small>
          )}
        </label>

        <label className="fw-field">
          <span>名字</span>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="显示在左栏的名字"
            disabled={busy}
          />
        </label>

        <div className="fw-agent-source">
          <span>创建内容</span>
          <b>agent.json + principle / preference / prompt</b>
          <small>三份人格文件创建后可以在右栏编辑。</small>
        </div>

        {error && <div className="fw-dialog-error">{error}</div>}

        <footer className="fw-dialog-actions">
          <button
            type="button"
            className="fw-dialog-cancel"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="fw-dialog-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? '添加中…' : '添加'}
          </button>
        </footer>
      </div>
    </div>
  )
}
