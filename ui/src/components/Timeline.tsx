import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import type { TurnCache } from '../cache'
import type { UiTurnMeta } from '../types'
import { Icon } from './Icon'
import { TurnBlock } from './TurnBlock'

interface Props {
  sessionId: string
  turns: UiTurnMeta[]
  cache: TurnCache
  refreshKey: number
}

export function Timeline({ sessionId, turns, cache, refreshKey }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 300,
    overscan: 4,
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
    if (turns.length === 0 || !atBottomRef.current) return
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(turns.length - 1, { align: 'end' })
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionId, turns.length, virtualizer])

  function onScroll(): void {
    const node = parentRef.current
    if (!node) return
    const next = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    atBottomRef.current = next
    setAtBottom(next)
  }

  function toBottom(): void {
    if (turns.length === 0) return
    virtualizer.scrollToIndex(turns.length - 1, { align: 'end' })
    atBottomRef.current = true
    setAtBottom(true)
  }

  if (turns.length === 0) {
    return (
      <div className="timeline-empty">
        <span className="timeline-empty-mark">✦</span>
        <h3>还没有对话</h3>
        <p>在下面说第一句话。每一轮都会落成事件，不会丢。</p>
      </div>
    )
  }

  return (
    <div className="timeline-shell">
      <div ref={parentRef} className="timeline" onScroll={onScroll}>
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
      {!atBottom && (
        <button className="jump-bottom" onClick={toBottom} title="回到最新">
          <Icon name="chevron" size={15} />
        </button>
      )}
    </div>
  )
}
