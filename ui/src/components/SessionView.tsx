import { useCallback, useState } from 'react'
import { api } from '../api'
import { useSession } from '../hooks/useSession'
import type { AgentSummary, SessionInfo } from '../types'
import { ChatComposer } from './ChatComposer'
import { Icon } from './Icon'
import { Timeline } from './Timeline'

export function SessionView({
  session,
  agent,
  onSent,
}: {
  session: SessionInfo
  agent?: AgentSummary
  onSent?: () => void | Promise<void>
}) {
  const { turns, cache, revision, loading, error, inspection, refresh } = useSession(session.id)
  const [sending, setSending] = useState(false)
  const lifecycle = inspection?.lifecycle ?? session.lifecycle
  const modelMissing = agent ? !agent.modelConfigured : false
  const disabled = lifecycle !== 'active' || modelMissing
  const disabledReason = lifecycle === 'archived'
    ? '这个会话已归档。恢复后可以继续发送。'
    : lifecycle === 'deleted'
      ? '这个会话已删除，只能查看历史。'
      : modelMissing
        ? '这个 agent 还没有配置模型，请在右侧状态面板选择模型。'
        : undefined
  const activeTurn = inspection?.state === 'running' || inspection?.state === 'waiting'
    ? turns.at(-1)?.turn
    : undefined
  const modelLabel = agent?.model
    ? `${agent.model.provider}/${agent.model.model}`
    : undefined
  const agentName = agent?.name ?? agent?.id

  const send = useCallback(async (text: string): Promise<void> => {
    setSending(true)
    try {
      const pending = api.sendMessage(session.id, text)
      window.setTimeout(() => { void refresh() }, 200)
      await pending
      await Promise.allSettled([
        refresh(),
        Promise.resolve(onSent?.()),
      ])
    } finally {
      setSending(false)
    }
  }, [onSent, refresh, session.id])

  return (
    <div className="fw-session-view">
      {error && (
        <div className="fw-session-error">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </div>
      )}

      {turns.length === 0 && loading && (
        <div className="fw-session-loading">
          <span className="fw-spinner" aria-label="载入会话" />
        </div>
      )}

      {turns.length === 0 && !loading && (
        <div className="fw-session-empty">
          <Icon name="chat" size={22} />
          <span>这个会话还没有消息</span>
          <small>在下面说第一句话。</small>
        </div>
      )}

      {turns.length > 0 && (
        <Timeline
          sessionId={session.id}
          turns={turns}
          cache={cache}
          refreshKey={revision}
          activeTurn={activeTurn}
          {...(agentName ? { agentName } : {})}
          {...(modelLabel ? { modelLabel } : {})}
        />
      )}

      <ChatComposer
        disabled={disabled}
        {...(disabledReason ? { disabledReason } : {})}
        sending={sending}
        {...(agent?.model ? { modelLabel: `${agent.model.provider}/${agent.model.model}` } : {})}
        onSend={send}
      />
    </div>
  )
}
