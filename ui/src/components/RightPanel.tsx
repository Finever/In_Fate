import type { ReactNode } from 'react'
import { IconButton } from './Ui'

export function RightPanel({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <aside className="right-panel" aria-label={title}>
      <header className="right-head">
        <h2>{title}</h2>
        <IconButton icon="close" label="关闭" onClick={onClose} />
      </header>
      <div className="right-body">{children}</div>
    </aside>
  )
}
