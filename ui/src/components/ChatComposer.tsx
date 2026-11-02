import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

export function ChatComposer({
  disabled,
  disabledReason,
  sending,
  modelLabel,
  onSend,
}: {
  disabled: boolean
  disabledReason?: string
  sending: boolean
  modelLabel?: string
  onSend: (text: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = '0px'
    node.style.height = `${Math.min(180, Math.max(54, node.scrollHeight))}px`
  }, [draft])

  async function submit(): Promise<void> {
    const text = draft.trim()
    if (!text || disabled || sending) return
    setDraft('')
    setError(undefined)
    try {
      await onSend(text)
      ref.current?.focus()
    } catch (reason) {
      setDraft(text)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  if (disabled) {
    return (
      <div className="fw-composer-wrap">
        <div className="fw-composer fw-composer-disabled">
          <Icon name="archive" size={15} />
          <span>{disabledReason ?? '这个会话现在不能发送消息'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="fw-composer-wrap">
      <div className={`fw-composer${sending ? ' is-sending' : ''}`}>
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          aria-label="消息"
          placeholder="输入消息…"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            if (event.shiftKey) return
            event.preventDefault()
            void submit()
          }}
        />
        <div className="fw-composer-bar">
          <div className="fw-composer-left">
            <span className="fw-model-chip">
              <img src="/icon.png" alt="" />
              {modelLabel ?? 'IF'}
            </span>
            <span className="fw-composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <button
            type="button"
            className="fw-send"
            disabled={sending || !draft.trim()}
            onClick={() => void submit()}
            aria-label="发送"
            title="发送"
          >
            {sending ? <span className="fw-spinner" /> : <Icon name="send" size={16} />}
          </button>
        </div>
        {error && <div className="fw-composer-error">{error}</div>}
      </div>
    </div>
  )
}
