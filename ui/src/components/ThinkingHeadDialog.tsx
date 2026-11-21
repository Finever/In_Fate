import { useEffect, useState } from 'react'
import { Icon } from './Icon'

export function ThinkingHeadDialog({
  supported,
  initialEnabled,
  initialText,
  onClose,
  onSubmit,
}: {
  supported: boolean
  initialEnabled: boolean
  initialText: string
  onClose: () => void
  onSubmit: (input: { enabled: boolean; text: string }) => Promise<void> | void
}) {
  const [enabled, setEnabled] = useState(initialEnabled && supported)
  const [text, setText] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const trimmed = text.trim()
  const canSubmit = !busy && (!enabled || trimmed.length > 0)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit({ enabled, text: trimmed })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fw-modal-backdrop fw-prompt-backdrop"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="fw-agent-dialog fw-thinking-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="会话思考头"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <h2>会话思考头</h2>
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

        <p className="fw-thinking-note">
          开启后，这段文本会作为最后一条 assistant 消息的续写前缀发给模型。
          只对支持 assistant prefill 的接口生效。
        </p>

        <label className="fw-thinking-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !supported}
            onChange={event => setEnabled(event.target.checked)}
          />
          <span>在本会话启用</span>
        </label>

        {!supported && (
          <div className="fw-thinking-warning">
            当前 agent 的主模型接口不支持 assistant prefill，不能启用。
          </div>
        )}

        <label className="fw-field">
          <span>思考头文本</span>
          <textarea
            autoFocus
            rows={6}
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="例如：先复述目标，再列出已知和未知，再检查风险，最后给结论。"
            disabled={busy}
            spellCheck={false}
          />
        </label>

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
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}