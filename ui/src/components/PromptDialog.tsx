import { useEffect, useState } from 'react'
import { Icon } from './Icon'

export function PromptDialog({
  title,
  label,
  placeholder,
  defaultValue = '',
  confirmLabel = '确定',
  allowEmpty = false,
  onClose,
  onSubmit,
}: {
  title: string
  label: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  allowEmpty?: boolean
  onClose: () => void
  onSubmit: (value: string) => Promise<void> | void
}) {
  const [value, setValue] = useState(defaultValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const trimmed = value.trim()
  const canSubmit = (allowEmpty || trimmed.length > 0) && !busy

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit(trimmed)
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
        className="fw-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <h2>{title}</h2>
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
          <span>{label}</span>
          <input
            autoFocus
            value={value}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={placeholder}
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
            {busy ? '处理中…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
