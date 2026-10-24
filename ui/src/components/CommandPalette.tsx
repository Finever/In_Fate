import { useEffect, useMemo, useRef, useState } from 'react'
import { relativeTime } from '../lib/format'
import { modLabel } from '../lib/platform'
import { sessionDisplayTitle, sessionSearchText } from '../lib/sessions'
import type { SessionInfo } from '../types'
import { Icon } from './Icon'
import { StatusDot } from './Ui'

interface Item {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

export function CommandPalette({
  open,
  sessions,
  onClose,
  onSelect,
  onCreate,
  onApprovals,
  onAgents,
  onToggleArchived,
  onToggleDeleted,
  showArchived,
  showDeleted,
}: {
  open: boolean
  sessions: SessionInfo[]
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: () => void
  onApprovals: () => void
  onAgents: () => void
  onToggleArchived: () => void
  onToggleDeleted: () => void
  showArchived: boolean
  showDeleted: boolean
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const items = useMemo<Item[]>(() => {
    const actions: Item[] = [
      { id: 'new', label: '新建会话', hint: '立即创建并打开', group: '动作', run: onCreate },
      { id: 'approvals', label: '打开审批', group: '动作', run: onApprovals },
      { id: 'agents', label: '打开子 agent', group: '动作', run: onAgents },
      {
        id: 'toggle-archived',
        label: showArchived ? '隐藏归档会话' : '显示归档会话',
        group: '视图',
        run: onToggleArchived,
      },
      {
        id: 'toggle-deleted',
        label: showDeleted ? '隐藏已删除会话' : '显示已删除会话',
        group: '视图',
        run: onToggleDeleted,
      },
    ]
    const sessionItems: Item[] = sessions.map(session => ({
      id: `session:${session.id}`,
      label: sessionDisplayTitle(session),
      hint: `${session.createdBy ?? 'user'} · ${session.state ?? 'unknown'} · ${relativeTime(session.updatedAt)}`,
      group: session.lifecycle === 'active' ? '会话' : '归档 / 删除',
      run: () => onSelect(session.id),
    }))
    const all = [...actions, ...sessionItems]
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter(item => {
      if (item.id.startsWith('session:')) {
        const session = sessions.find(candidate => `session:${candidate.id}` === item.id)
        if (session && sessionSearchText(session).includes(needle)) return true
      }
      return `${item.label} ${item.hint ?? ''} ${item.id}`.toLowerCase().includes(needle)
    })
  }, [
    onAgents,
    onApprovals,
    onCreate,
    onSelect,
    onToggleArchived,
    onToggleDeleted,
    query,
    sessions,
    showArchived,
    showDeleted,
  ])

  useEffect(() => {
    setIndex(current => Math.min(current, Math.max(0, items.length - 1)))
  }, [items.length])

  if (!open) return null

  function choose(item: Item | undefined): void {
    if (!item) return
    item.run()
    onClose()
  }

  return (
    <div className="palette-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            placeholder="搜索会话、执行命令…"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex(current => Math.min(items.length - 1, current + 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex(current => Math.max(0, current - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(items[index])
              }
            }}
          />
          <kbd>esc</kbd>
        </div>

        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">没有匹配项</div>}
          {items.map((item, itemIndex) => (
            <button
              key={item.id}
              className={`palette-item${itemIndex === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => choose(item)}
            >
              <span className="palette-group">{item.group}</span>
              <span className="palette-label">
                {item.id.startsWith('session:') && <StatusDot state={sessions.find(s => `session:${s.id}` === item.id)?.state} />}
                {item.label}
              </span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </button>
          ))}
        </div>

        <footer className="palette-foot">
          <span>{modLabel} K 开关</span>
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </footer>
      </div>
    </div>
  )
}
