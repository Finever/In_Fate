import { useState } from 'react'
import { api } from '../api'
import type { UiContent, UiTimelineItem } from '../types'

interface Props {
  sessionId: string
  item: UiTimelineItem
}

function stamp(ts: string): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function statusClass(item: UiTimelineItem): string {
  return item.status ? ` status-${item.status}` : ''
}

export function ItemCard({ sessionId, item }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [full, setFull] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const content: UiContent | undefined = item.kind === 'tool'
    ? item.tool?.result
    : item.content
  const target = content?.ref
    ? { ref: content.ref }
    : item.kind === 'tool'
      ? (item.tool?.resultEventId ? { eventId: item.tool.resultEventId } : undefined)
      : { eventId: item.id }

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
      <div className={`item item-turn${statusClass(item)}`}>
        <div className="turn-line">
          <span>{item.status === 'cancelled' ? '本轮中断' : '本轮完成'}</span>
          {usage && (
            <span className="chips">
              <span className="chip">{usage.steps} 步</span>
              <span className="chip">入 {usage.usage.input}</span>
              <span className="chip">出 {usage.usage.output}</span>
              <span className="chip">缓存 {usage.usage.cacheRead}</span>
              {usage.hitLimit && <span className="chip warn">触顶</span>}
            </span>
          )}
          <span className="time">{stamp(item.ts)}</span>
        </div>
      </div>
    )
  }

  if (item.kind === 'compaction') {
    return (
      <div className="item item-compaction">
        <div className="item-head">
          <span className="badge">压缩</span>
          <span className="item-title">{item.title}</span>
          <span className="time">{stamp(item.ts)}</span>
        </div>
        <pre className="text dim">{JSON.stringify(item.compaction?.summary, null, 2)}</pre>
      </div>
    )
  }

  if (item.kind === 'tool') {
    const tool = item.tool
    return (
      <div className={`item item-tool${statusClass(item)}`}>
        <div className="item-head">
          <span className="badge tool-badge">{tool?.name ?? '工具'}</span>
          <span className={`tool-status ${tool?.status ?? 'running'}`}>
            {tool?.status === 'running' ? '运行中' : tool?.status === 'error' ? '失败' : '完成'}
          </span>
          {tool?.durationMs !== undefined && <span className="time">{tool.durationMs}ms</span>}
          <span className="time">{stamp(item.ts)}</span>
        </div>
        {tool?.argsPreview && <pre className="text args">{tool.argsPreview}</pre>}
        {content && (
          <>
            <pre className="text result">{expanded && full !== undefined ? full : content.preview}</pre>
            {loading && <div className="loading">取回全文…</div>}
            {error && <div className="error">{error}</div>}
            {canExpand && (
              <button className="link" onClick={() => void toggle()}>
                {expanded ? '收起原文' : `展开全文 · ${Math.ceil(content.bytes / 1024)} KB`}
              </button>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className={`item item-${item.kind}${statusClass(item)}`}>
      <div className="item-head">
        <span className={`badge kind-${item.kind}`}>{item.kind === 'user' ? '你' : item.title}</span>
        <span className="time">{stamp(item.ts)}</span>
      </div>
      {content && (
        <>
          <pre className="text">{expanded && full !== undefined ? full : content.preview}</pre>
          {loading && <div className="loading">取回全文…</div>}
          {error && <div className="error">{error}</div>}
          {canExpand && (
            <button className="link" onClick={() => void toggle()}>
              {expanded ? '收起原文' : `展开全文 · ${Math.ceil(content.bytes / 1024)} KB`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
