import { useEffect, useMemo, useRef, useState } from 'react'
import { layoutConstellation, linkCurve } from '../lib/constellation'
import { relativeTime, shortId } from '../lib/format'
import type { SessionInfo, SessionLink } from '../types'
import { Icon } from './Icon'

function useSize(): {
  ref: React.RefObject<HTMLDivElement | null>
  size: { w: number; h: number }
} {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ w: rect.width, h: rect.height })
    })
    observer.observe(node)
    setSize({ w: node.clientWidth, h: node.clientHeight })
    return () => observer.disconnect()
  }, [])
  return { ref, size }
}

export function Constellation({
  sessions,
  links,
  selectedId,
  focused,
  onSelect,
}: {
  sessions: SessionInfo[]
  links: SessionLink[]
  selectedId?: string
  focused: boolean
  onSelect: (id: string) => void
}) {
  const { ref, size } = useSize()
  const byId = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])

  const activeLinks = useMemo(() => links.filter(link =>
    link.status === 'active'
    && byId.has(link.from)
    && byId.has(link.to)), [byId, links])

  const points = useMemo(() => layoutConstellation(
    sessions.map(session => session.id),
    activeLinks.map(link => ({ from: link.from, to: link.to })),
    size.w,
    size.h,
  ), [activeLinks, sessions, size.h, size.w])

  return (
    <div ref={ref} className={`constellation${focused ? ' focused' : ''}`}>
      {!focused && sessions.length > 0 && (
        <div className="constellation-core">
          <span className="core-mark">IF</span>
          <h2>In_Fate</h2>
          <p>选择一颗会话，或按 ⌘K</p>
          <div className="core-stats">
            <span>{sessions.filter(item => item.lifecycle === 'active').length} 活跃</span>
            <span>·</span>
            <span>{activeLinks.length} 连接</span>
          </div>
        </div>
      )}

      {sessions.length === 0 && (
        <div className="constellation-empty">
          <span className="constellation-empty-mark"><Icon name="layers" size={30} /></span>
          <h2>还没有会话</h2>
          <p>右下角“新建”，或按 ⌘K。</p>
        </div>
      )}

      <svg className="constellation-lines" width={size.w} height={size.h} aria-hidden="true">
        {activeLinks.map((link, index) => {
          const from = points.get(link.from)
          const to = points.get(link.to)
          if (!from || !to) return null
          return (
            <path
              key={link.linkId}
              className={`constellation-link link-${link.relation}${selectedId === link.from || selectedId === link.to ? ' active' : ''}`}
              d={linkCurve(from, to, index)}
            >
              <title>{`${link.relation}: ${shortId(link.from)} → ${shortId(link.to)}`}</title>
            </path>
          )
        })}
      </svg>

      {sessions.map(session => {
        const point = points.get(session.id)
        if (!point) return null
        const selected = session.id === selectedId
        return (
          <button
            key={session.id}
            className={[
              'constellation-node',
              `lifecycle-${session.lifecycle}`,
              `state-${session.state ?? 'unknown'}`,
              selected ? 'selected' : '',
              (focused && !selected) ? 'background' : '',
            ].filter(Boolean).join(' ')}
            style={{ left: point.x, top: point.y }}
            onClick={() => onSelect(session.id)}
            title={session.reason ?? session.id}
          >
            <span className="node-dot" />
            <span className="node-body">
              <span className="node-name">{shortId(session.id, 18)}</span>
              <span className="node-meta">
                {session.createdBy ?? 'user'} · {relativeTime(session.updatedAt)}
              </span>
            </span>
            {session.kind === 'agent' && <span className="node-kind">agent</span>}
          </button>
        )
      })}
    </div>
  )
}
