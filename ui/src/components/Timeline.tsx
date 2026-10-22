import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import type { TurnCache } from '../cache'
import type { UiTurnMeta } from '../types'
import { TurnBlock } from './TurnBlock'

interface Props {
  sessionId: string
  turns: UiTurnMeta[]
  cache: TurnCache
  refreshKey: number
}

export function Timeline({ sessionId, turns, cache, refreshKey }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280,
    overscan: 3,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const visible = new Set<number>(
    virtualItems
      .map(item => turns[item.index]?.turn)
      .filter((turn): turn is number => turn !== undefined),
  )
  const visibleKey = [...visible].sort((a, b) => a - b).join(',')

  useEffect(() => {
    cache.evictOutside(visible)
  }, [cache, visibleKey])

  useEffect(() => {
    if (turns.length === 0) return
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(turns.length - 1, { align: 'end' })
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionId, turns.length])

  if (turns.length === 0) {
    return <div className="empty">还没有消息。下面说点什么。</div>
  }

  return (
    <div ref={parentRef} className="timeline">
      <div className="timeline-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map(item => {
          const meta = turns[item.index]!
          return (
            <div
              key={meta.turn}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="virtual-row"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TurnBlock
                sessionId={sessionId}
                meta={meta}
                cache={cache}
                refreshKey={refreshKey}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
