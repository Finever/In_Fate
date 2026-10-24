import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

export function Composer({
  disabled,
  disabledReason,
  sending,
  onSend,
}: {
  disabled: boolean
  disabledReason?: string
  sending: boolean
  onSend: (text: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = '0px'
    node.style.height = `${Math.min(180, Math.max(52, node.scrollHeight))}px`
  }, [draft])

  async function submit(): Promise<void> {
    const text = draft.trim()
    if (!text || disabled || sending) return
    setDraft('')
    try {
      await onSend(text)
    } catch {
      setDraft(text)
    }
  }

  if (disabled) {
    return (
      <div className="composer disabled">
        <div className="composer-locked">
          <Icon name="archive" size={16} />
          <span>{disabledReason ?? '这个会话现在不能发送消息'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        placeholder="对她说点什么…"
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-side">
        <span className="composer-hint">Ctrl / ⌘ + Enter</span>
        <button
          className="send-btn"
          disabled={sending || !draft.trim()}
          onClick={() => void submit()}
          aria-label="发送"
        >
          {sending ? <span className="spinner" /> : <Icon name="send" size={17} />}
        </button>
      </div>
    </div>
  )
}
