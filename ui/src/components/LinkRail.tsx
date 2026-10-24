import { useEffect, useState, type RefObject } from 'react'
import { linkedSessions } from '../lib/sessions'
import type { SessionInfo, SessionLink } from '../types'

interface Path {
  key: string
  d: string
  relation: SessionLink['relation']
  y1: number
}

/**
 * 选中会话时，从列表行的左缘引出曲线，连到直接关联的会话。
 * 线只画在行左侧的留白里，不压标题；列表滚动时随内容一起移动。
 */
export function LinkRail({
  contentRef,
  selectedId,
  links,
  sessions,
  revision,
}: {
  contentRef: RefObject<HTMLDivElement | null>
  selectedId: string | undefined
  links: SessionLink[]
  sessions: SessionInfo[]
  revision: string
}) {
  const [paths, setPaths] = useState<Path[]>([])
  const [height, setHeight] = useState(0)

  const linkSignature = links
    .filter(link => link.status === 'active' && (link.from === selectedId || link.to === selectedId))
    .map(link => `${link.from}:${link.to}:${link.relation}`)
    .sort()
    .join('|')
  const sessionSignature = sessions.map(session => session.id).join(',')

  useEffect(() => {
    const content = contentRef.current
    if (!content || !selectedId) {
      setPaths([])
      setHeight(0)
      return
    }

    const rows = new Map<string, HTMLElement>()
    content.querySelectorAll<HTMLElement>('[data-session-id]').forEach(element => {
      const id = element.dataset.sessionId
      if (id) rows.set(id, element)
    })
    const base = content.getBoundingClientRect()
    const yOf = (element: HTMLElement): number =>
      element.getBoundingClientRect().top - base.top + element.offsetHeight / 2

    const selectedRow = rows.get(selectedId)
    if (!selectedRow) {
      setPaths([])
      setHeight(0)
      return
    }

    const related = linkedSessions(links, selectedId, sessions)
    const next: Path[] = []
    related.forEach((item, index) => {
      const row = rows.get(item.session.id)
      if (!row) return
      const y0 = yOf(selectedRow)
      const y1 = yOf(row)
      const lane = 5 + (index % 4) * 2
      const edge = 18
      next.push({
        key: `${item.session.id}:${item.relation}`,
        relation: item.relation,
        y1,
        d: `M ${edge} ${y0} C ${lane} ${y0}, ${lane} ${y1}, ${edge} ${y1}`,
      })
    })

    setPaths(next)
    setHeight(content.offsetHeight)
  }, [contentRef, linkSignature, selectedId, sessionSignature, revision])

  if (paths.length === 0 || height === 0) return null

  return (
    <svg
      className="link-rail"
      width="100%"
      height={height}
      aria-hidden="true"
    >
      {paths.map(path => (
        <g key={path.key} className={`link-line relation-${path.relation}`}>
          <path d={path.d} />
          <circle cx={18} cy={path.y1} r={1.7} />
        </g>
      ))}
    </svg>
  )
}
