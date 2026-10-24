import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { SessionLifecycle, SessionState } from '../types'
import { Icon, type IconName } from './Icon'

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: IconName
}) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`.trim()} {...props}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  )
}

export function IconButton({
  icon,
  label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      className={`icon-btn ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} size={17} />
    </button>
  )
}

type Tone = 'neutral' | 'accent' | 'mint' | 'warn' | 'danger' | 'muted'

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return <span className={`badge tone-${tone} ${className}`.trim()}>{children}</span>
}

export function LifecycleBadge({ lifecycle }: { lifecycle: SessionLifecycle }) {
  const map: Record<SessionLifecycle, { tone: Tone; label: string }> = {
    active: { tone: 'mint', label: '活跃' },
    archived: { tone: 'muted', label: '归档' },
    deleted: { tone: 'danger', label: '已删除' },
  }
  const item = map[lifecycle]
  return <Badge tone={item.tone}>{item.label}</Badge>
}

export function StatusDot({ state }: { state: SessionState | undefined }) {
  const known = state === 'running'
    || state === 'waiting'
    || state === 'idle'
    || state === 'done'
    || state === 'unknown'
  return <span className={`status-dot ${known ? state : 'unknown'}`} aria-hidden="true" />
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  )
}

export function EmptyState({
  icon = 'info',
  title,
  body,
  action,
}: {
  icon?: IconName
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={26} /></span>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  )
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="section-title">
      <span>{children}</span>
      {right}
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '确认',
  danger = false,
  busy = false,
  extra,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  extra?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div className="dialog-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {body && <p>{body}</p>}
        {extra}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function Drawer({
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
    <div className="drawer-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}
