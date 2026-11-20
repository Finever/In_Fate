import { useState } from 'react'
import { api } from '../api'
import { formatClock, formatDuration } from '../lib/format'
import { Markdown } from '../lib/markdown'
import type { UiContent, UiTimelineItem } from '../types'
import { Icon } from './Icon'
import { TurnMetrics } from './TurnMetrics'

interface Props {
  sessionId: string
  item: UiTimelineItem
  bare?: boolean
  inProcess?: boolean
  /** 这一轮实际使用的模型；用到时替代软件名。 */
  modelLabel?: string
}

/** 只清掉 assistant 正文开头的时间戳，正文中间的日期不碰。 */
function stripLeadingTimestamp(text: string): string {
  return text.replace(
    /^\s*[\[【]\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?[\]】]\s*/,
    '',
  )
}

type ContentTarget = { ref: string } | { eventId: string } | undefined

function targetOf(item: UiTimelineItem, content: UiContent | undefined): ContentTarget {
  if (content?.ref) return { ref: content.ref }
  if (item.kind === 'tool' && item.tool?.resultEventId) return { eventId: item.tool.resultEventId }
  if (item.kind !== 'tool') return { eventId: item.id }
  return undefined
}

function ExpandButton({
  canExpand,
  expanded,
  bytes,
  loading,
  onClick,
}: {
  canExpand: boolean
  expanded: boolean
  bytes: number
  loading: boolean
  onClick: () => void
}) {
  if (!canExpand) return null
  return (
    <button type="button" className="text-link" onClick={onClick} disabled={loading}>
      {loading ? '取回全文…' : expanded ? '收起' : `展开全文 · ${Math.ceil(bytes / 1024)} KB`}
    </button>
  )
}

function ToolStatus({ status }: { status: 'running' | 'ok' | 'error' | undefined }) {
  return (
    <span className={`process-status ${status ?? 'running'}`}>
      {status === 'running' ? '运行中' : status === 'error' ? '失败' : '完成'}
    </span>
  )
}

export function ItemCard({ sessionId, item, bare = false, inProcess = false, modelLabel }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [full, setFull] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const content: UiContent | undefined = item.kind === 'tool'
    ? item.tool?.result
    : item.content
  const target = targetOf(item, content)
  const canExpand = Boolean(content?.truncated && target)

  async function toggle(): Promise<void> {
    if (expanded) {
      setExpanded(false)
      setFull(undefined)
      return
    }
    setExpanded(true)
    if (full || !canExpand || !target) return
    setLoading(true)
    setError(undefined)
    try {
      const slice = await api.payload(sessionId, { ...target, limit: 200_000 })
      setFull(slice.data)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const text = expanded && full !== undefined ? full : content?.preview ?? ''
  const displayText = item.kind === 'assistant' ? stripLeadingTimestamp(text) : text

  if (item.kind === 'user') {
    return (
      <article className="msg msg-user">
        <div className="msg-bubble">
          <Markdown text={text} />
          <ExpandButton
            canExpand={canExpand}
            expanded={expanded}
            bytes={content?.bytes ?? 0}
            loading={loading}
            onClick={() => void toggle()}
          />
        </div>
        {error && <div className="inline-error">{error}</div>}
        <span className="msg-time">{formatClock(item.ts)}</span>
      </article>
    )
  }

  if (item.kind === 'assistant') {
    if (bare) {
      return (
        <div className="turn-output">
          <div className="msg-content">
            <Markdown text={displayText} />
            <ExpandButton
              canExpand={canExpand}
              expanded={expanded}
              bytes={content?.bytes ?? 0}
              loading={loading}
              onClick={() => void toggle()}
            />
          </div>
          {error && <div className="inline-error">{error}</div>}
        </div>
      )
    }
    return (
      <article className="msg msg-assistant">
        <img className="msg-avatar" src="/icon.png" alt="" />
        <div className="msg-main">
          <div className="msg-head">
            <span>{modelLabel ?? '模型'}</span>
            <span className="msg-time">{formatClock(item.ts)}</span>
          </div>
          <div className="msg-content">
            <Markdown text={displayText} />
            <ExpandButton
              canExpand={canExpand}
              expanded={expanded}
              bytes={content?.bytes ?? 0}
              loading={loading}
              onClick={() => void toggle()}
            />
          </div>
          {error && <div className="inline-error">{error}</div>}
        </div>
      </article>
    )
  }

  if (item.kind === 'system') {
    return (
      <div className="msg-system">
        <Markdown text={text} />
        <ExpandButton
          canExpand={canExpand}
          expanded={expanded}
          bytes={content?.bytes ?? 0}
          loading={loading}
          onClick={() => void toggle()}
        />
        {error && <div className="inline-error">{error}</div>}
      </div>
    )
  }

  if (item.kind === 'tool') {
    const tool = item.tool
    return (
      <details className={`process-row tool-row status-${tool?.status ?? 'running'}`}>
        <summary>
          <span className="process-icon"><Icon name="tool" size={13} /></span>
          <span className="process-title">{tool?.name ?? '工具'}</span>
          <ToolStatus status={tool?.status} />
          {tool?.durationMs !== undefined && <span className="process-meta">{formatDuration(tool.durationMs)}</span>}
          <span className="process-meta">{formatClock(item.ts)}</span>
          <Icon name="down" size={13} className="process-chevron" />
        </summary>
        <div className="process-body">
          {tool?.argsPreview && (
            <div className="process-block">
              <span className="process-label">参数</span>
              <pre className="code-block">{tool.argsPreview}</pre>
            </div>
          )}
          {content && (
            <div className="process-block">
              <span className="process-label">结果</span>
              <pre className="code-block result-block">{text}</pre>
              <ExpandButton
                canExpand={canExpand}
                expanded={expanded}
                bytes={content.bytes}
                loading={loading}
                onClick={() => void toggle()}
              />
            </div>
          )}
          {error && <div className="inline-error">{error}</div>}
        </div>
      </details>
    )
  }

  if (item.kind === 'thoughts') {
    if (inProcess) {
      return (
        <div className="turn-thought">
          <div className="turn-thought-head">
            <span className="process-icon"><Icon name="layers" size={13} /></span>
            <span className="process-title">思考</span>
            <span className="process-meta">{formatClock(item.ts)}</span>
          </div>
          <div className="turn-thought-body">
            <Markdown text={text} />
            <ExpandButton
              canExpand={canExpand}
              expanded={expanded}
              bytes={content?.bytes ?? 0}
              loading={loading}
              onClick={() => void toggle()}
            />
          </div>
          {error && <div className="inline-error">{error}</div>}
        </div>
      )
    }
    return (
      <details className="process-row thought-row">
        <summary>
          <span className="process-icon"><Icon name="layers" size={13} /></span>
          <span className="process-title">思考</span>
          <span className="process-meta">{formatClock(item.ts)}</span>
          <Icon name="down" size={13} className="process-chevron" />
        </summary>
        <div className="process-body">
          <Markdown text={text} />
          <ExpandButton
            canExpand={canExpand}
            expanded={expanded}
            bytes={content?.bytes ?? 0}
            loading={loading}
            onClick={() => void toggle()}
          />
          {error && <div className="inline-error">{error}</div>}
        </div>
      </details>
    )
  }

  if (item.kind === 'compaction') {
    return (
      <details className="process-row compaction-row">
        <summary>
          <span className="process-icon"><Icon name="layers" size={13} /></span>
          <span className="process-title">压缩</span>
          <span className="process-meta">{item.title}</span>
          <span className="process-meta">{formatClock(item.ts)}</span>
          <Icon name="down" size={13} className="process-chevron" />
        </summary>
        <div className="process-body">
          <pre className="code-block">{JSON.stringify(item.compaction?.summary, null, 2)}</pre>
        </div>
      </details>
    )
  }

  // turn 完成行：显示本轮用量，点击打开明细。
  return <TurnMetrics item={item} />
}
