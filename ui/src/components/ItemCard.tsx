import { useState, type ReactNode } from 'react'
import { api } from '../api'
import { formatClock } from '../lib/format'
import { Markdown } from '../lib/markdown'
import type { UiContent, UiTimelineItem } from '../types'
import { Icon } from './Icon'

interface Props {
  sessionId: string
  item: UiTimelineItem
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
    <button className="text-link" onClick={onClick} disabled={loading}>
      {loading ? '取回全文…' : expanded ? '收起' : `展开全文 · ${Math.ceil(bytes / 1024)} KB`}
    </button>
  )
}

function Collapsible({
  className,
  summary,
  children,
  defaultOpen = false,
}: {
  className: string
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details className={className} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  )
}

export function ItemCard({ sessionId, item }: Props) {
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

  if (item.kind === 'turn') {
    const usage = item.turnUsage
    return (
      <div className={`turn-summary${item.status === 'cancelled' ? ' cancelled' : ''}`}>
        <span className="turn-summary-mark">{item.status === 'cancelled' ? '中断' : '完成'}</span>
        {usage && (
          <span className="chips">
            <span className="chip">{usage.steps} 步</span>
            <span className="chip">入 {usage.usage.input}</span>
            <span className="chip">出 {usage.usage.output}</span>
            <span className="chip">缓存 {usage.usage.cacheRead}</span>
            {usage.hitLimit && <span className="chip warn">触顶</span>}
          </span>
        )}
        <span className="entry-time">{formatClock(item.ts)}</span>
      </div>
    )
  }

  if (item.kind === 'compaction') {
    return (
      <Collapsible
        className="entry entry-compaction"
        summary={(
          <>
            <span className="entry-label">压缩</span>
            <span className="entry-title">{item.title}</span>
            <span className="entry-time">{formatClock(item.ts)}</span>
          </>
        )}
      >
        <pre className="code-block">{JSON.stringify(item.compaction?.summary, null, 2)}</pre>
      </Collapsible>
    )
  }

  if (item.kind === 'tool') {
    const tool = item.tool
    return (
      <div className={`entry entry-tool status-${tool?.status ?? 'running'}`}>
        <div className="entry-head">
          <span className="tool-mark"><Icon name="tool" size={13} /></span>
          <span className="entry-label tool-name">{tool?.name ?? '工具'}</span>
          <span className={`tool-state ${tool?.status ?? 'running'}`}>
            {tool?.status === 'running' ? '运行中' : tool?.status === 'error' ? '失败' : '完成'}
          </span>
          {tool?.durationMs !== undefined && <span className="entry-time">{tool.durationMs} ms</span>}
          <span className="entry-time">{formatClock(item.ts)}</span>
        </div>
        {tool?.argsPreview && (
          <details className="tool-args">
            <summary>参数</summary>
            <pre className="code-block">{tool.argsPreview}</pre>
          </details>
        )}
        {content && (
          <>
            <pre className="code-block result-block">
              {expanded && full !== undefined ? full : content.preview}
            </pre>
            {error && <div className="inline-error">{error}</div>}
            <ExpandButton
              canExpand={canExpand}
              expanded={expanded}
              bytes={content.bytes}
              loading={loading}
              onClick={() => void toggle()}
            />
          </>
        )}
      </div>
    )
  }

  if (item.kind === 'thoughts') {
    return (
      <Collapsible
        className="entry entry-thoughts"
        summary={(
          <>
            <span className="entry-label">思考</span>
            <span className="entry-time">{formatClock(item.ts)}</span>
          </>
        )}
      >
        <Markdown text={content?.preview ?? ''} />
      </Collapsible>
    )
  }

  const label = item.kind === 'user'
    ? '你'
    : item.kind === 'assistant'
      ? '助手'
      : '系统'

  return (
    <div className={`entry entry-${item.kind}`}>
      <div className="entry-head">
        <span className={`entry-label kind-${item.kind}`}>{label}</span>
        <span className="entry-time">{formatClock(item.ts)}</span>
      </div>
      <div className="entry-body">
        <Markdown text={expanded && full !== undefined ? full : content?.preview ?? ''} />
        {error && <div className="inline-error">{error}</div>}
        <ExpandButton
          canExpand={canExpand}
          expanded={expanded}
          bytes={content?.bytes ?? 0}
          loading={loading}
          onClick={() => void toggle()}
        />
      </div>
    </div>
  )
}
