import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken } from './api'
import { AgentsPanel } from './components/AgentsPanel'
import { ApprovalsPanel } from './components/ApprovalsPanel'
import { CommandPalette } from './components/CommandPalette'
import { Constellation } from './components/Constellation'
import { Dock } from './components/Dock'
import { FocusWindow } from './components/FocusWindow'
import { Icon } from './components/Icon'
import { Inspector } from './components/Inspector'
import { TopBar } from './components/TopBar'
import { Button, ConfirmDialog, Drawer, Spinner } from './components/Ui'
import { useSession } from './hooks/useSession'
import { useWorkspace } from './hooks/useWorkspace'

function TokenGate({ onReady }: { onReady: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="gate">
      <div className="gate-card">
        <span className="gate-mark">IF</span>
        <h1>In_Fate</h1>
        <p>输入 `if serve` 打印的 token。</p>
        <input
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="token"
          onKeyDown={event => {
            if (event.key === 'Enter' && value.trim()) {
              setToken(value.trim())
              onReady(value.trim())
            }
          }}
        />
        <Button
          variant="primary"
          onClick={() => {
            if (!value.trim()) return
            setToken(value.trim())
            onReady(value.trim())
          }}
        >
          进入
        </Button>
      </div>
    </div>
  )
}

export default function App() {
  const [token, setTokenState] = useState(getToken())
  if (!token) return <TokenGate onReady={setTokenState} />
  return <Desktop />
}

type ForceConfirm = { kind: 'archive' | 'delete'; id: string }

function Desktop() {
  const workspace = useWorkspace()
  const [selectedId, setSelectedId] = useState<string>()
  const session = useSession(selectedId)

  const [showArchived, setShowArchived] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string }>()
  const [deleteConfirm, setDeleteConfirm] = useState<string>()
  const [forceConfirm, setForceConfirm] = useState<ForceConfirm>()

  const selectedSession = workspace.sessions.find(item => item.id === selectedId)

  const visibleSessions = useMemo(() => workspace.sessions.filter(item => {
    if (item.lifecycle === 'active') return true
    if (item.lifecycle === 'archived') return showArchived
    return showDeleted
  }), [showArchived, showDeleted, workspace.sessions])

  const dockSessions = useMemo(() => workspace.sessions.filter(item =>
    item.lifecycle === 'active' || item.id === selectedId), [selectedId, workspace.sessions])

  const sessionApprovals = useMemo(() => workspace.approvals.filter(item =>
    item.sessionId === selectedId), [selectedId, workspace.approvals])

  const agentsRunning = workspace.agents.filter(agent =>
    agent.status === 'running' || agent.status === 'queued').length

  useEffect(() => {
    if (workspace.error) setToast({ kind: 'error', text: workspace.error })
  }, [workspace.error])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(value => !value)
        return
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setDetailsOpen(false)
        setApprovalsOpen(false)
        setAgentsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text })
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    setActionBusy(true)
    try {
      await Promise.all([workspace.refresh(true), session.refresh()])
    } finally {
      setActionBusy(false)
    }
  }, [session, workspace])

  const select = useCallback((id: string) => {
    setSelectedId(id)
    setDetailsOpen(false)
    setCommandOpen(false)
  }, [])

  const overview = useCallback(() => {
    setSelectedId(undefined)
    setDetailsOpen(false)
    setCommandOpen(false)
  }, [])

  const create = useCallback(async (): Promise<void> => {
    setActionBusy(true)
    try {
      const id = await api.createSession()
      await workspace.refresh(true)
      setSelectedId(id)
      notify('ok', '已新建会话')
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActionBusy(false)
    }
  }, [notify, workspace])

  const send = useCallback(async (text: string): Promise<void> => {
    if (!selectedId) throw new Error('没有选中会话')
    setSending(true)
    try {
      await api.sendMessage(selectedId, text)
      await Promise.all([session.refresh(), workspace.refresh(true)])
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : String(reason))
      throw reason
    } finally {
      setSending(false)
    }
  }, [notify, selectedId, session, workspace])

  const mutateLifecycle = useCallback(async (
    kind: 'archive' | 'unarchive' | 'delete',
    id: string,
    force = false,
  ): Promise<void> => {
    setActionBusy(true)
    try {
      if (kind === 'archive') await api.archiveSession(id)
      else if (kind === 'unarchive') await api.unarchiveSession(id)
      else await api.deleteSession(id, force ? { force: true } : {})
      await Promise.all([
        workspace.refresh(true),
        id === selectedId ? session.refresh() : Promise.resolve(),
      ])
      notify('ok', kind === 'archive' ? '已归档' : kind === 'unarchive' ? '已恢复' : '已删除')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (/running/i.test(message) && !force) {
        setForceConfirm({ kind: kind === 'unarchive' ? 'archive' : kind, id })
      } else {
        notify('error', message)
      }
    } finally {
      setActionBusy(false)
    }
  }, [notify, selectedId, session, workspace])

  const closeLink = useCallback(async (linkId: string): Promise<void> => {
    setActionBusy(true)
    try {
      await api.closeLink(linkId, 'ui')
      await workspace.refresh(true)
      notify('ok', '连接已关闭')
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActionBusy(false)
    }
  }, [notify, workspace])

  const respondApproval = useCallback(async (id: string, approved: boolean): Promise<void> => {
    setActionBusy(true)
    try {
      await api.respondApproval(id, approved)
      await Promise.all([workspace.refresh(true), session.refresh()])
      notify('ok', approved ? '已允许' : '已拒绝')
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActionBusy(false)
    }
  }, [notify, session, workspace])

  const fullscreen = useCallback(async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : String(reason))
    }
  }, [notify])

  if (workspace.loading && workspace.sessions.length === 0) {
    return (
      <div className="boot">
        <span className="brand-mark">IF</span>
        <Spinner label="载入工作区…" />
      </div>
    )
  }

  return (
    <div className={`desktop${selectedSession ? ' has-focus' : ''}`}>
      <TopBar
        sessions={workspace.sessions}
        selected={selectedSession}
        online={!workspace.error}
        refreshing={workspace.refreshing || session.loading}
        showArchived={showArchived}
        showDeleted={showDeleted}
        onToggleArchived={() => setShowArchived(value => !value)}
        onToggleDeleted={() => setShowDeleted(value => !value)}
        onCommand={() => setCommandOpen(true)}
        onRefresh={() => void refreshAll()}
        onFullscreen={() => void fullscreen()}
        onOverview={overview}
      />

      <Constellation
        sessions={visibleSessions}
        links={workspace.links}
        selectedId={selectedId}
        focused={Boolean(selectedSession)}
        onSelect={select}
      />

      {selectedSession && (
        <FocusWindow
          session={selectedSession}
          inspection={session.inspection}
          stats={session.stats}
          turns={session.turns}
          cache={session.cache}
          revision={session.revision}
          approvals={sessionApprovals}
          loading={session.loading}
          error={session.error}
          sending={sending}
          onSend={send}
          onRefresh={() => void refreshAll()}
          onClose={overview}
          onDetails={() => setDetailsOpen(true)}
          onArchive={() => void mutateLifecycle('archive', selectedSession.id)}
          onUnarchive={() => void mutateLifecycle('unarchive', selectedSession.id)}
          onDelete={() => setDeleteConfirm(selectedSession.id)}
          onOpenApprovals={() => setApprovalsOpen(true)}
        />
      )}

      <Dock
        sessions={dockSessions}
        selectedId={selectedId}
        approvals={workspace.approvals.length}
        agentsRunning={agentsRunning}
        onSelect={select}
        onCreate={() => void create()}
        onOverview={overview}
        onApprovals={() => setApprovalsOpen(true)}
        onAgents={() => setAgentsOpen(true)}
        onCommand={() => setCommandOpen(true)}
      />

      <Drawer
        open={detailsOpen && Boolean(selectedSession)}
        title="会话详情"
        onClose={() => setDetailsOpen(false)}
      >
        {selectedSession && (
          <Inspector
            session={selectedSession}
            inspection={session.inspection}
            stats={session.stats}
            links={workspace.links}
            busy={actionBusy}
            onArchive={() => void mutateLifecycle('archive', selectedSession.id)}
            onUnarchive={() => void mutateLifecycle('unarchive', selectedSession.id)}
            onDelete={() => setDeleteConfirm(selectedSession.id)}
            onCloseLink={linkId => void closeLink(linkId)}
          />
        )}
      </Drawer>

      <Drawer open={approvalsOpen} title="待审批" onClose={() => setApprovalsOpen(false)}>
        <ApprovalsPanel
          approvals={workspace.approvals}
          busy={actionBusy}
          onRespond={(id, approved) => void respondApproval(id, approved)}
        />
      </Drawer>

      <Drawer open={agentsOpen} title="子 agent" onClose={() => setAgentsOpen(false)}>
        <AgentsPanel agents={workspace.agents} />
      </Drawer>

      <CommandPalette
        open={commandOpen}
        sessions={workspace.sessions}
        onClose={() => setCommandOpen(false)}
        onSelect={select}
        onCreate={() => void create()}
        onApprovals={() => setApprovalsOpen(true)}
        onAgents={() => setAgentsOpen(true)}
        onToggleArchived={() => setShowArchived(value => !value)}
        onToggleDeleted={() => setShowDeleted(value => !value)}
        showArchived={showArchived}
        showDeleted={showDeleted}
      />

      <ConfirmDialog
        open={Boolean(deleteConfirm)}
        title="删除这个会话？"
        body="软删除：从默认列表隐藏，关闭连接并取消等待。历史文件保留，不做硬删除。"
        confirmLabel="删除"
        danger
        busy={actionBusy}
        onCancel={() => setDeleteConfirm(undefined)}
        onConfirm={() => {
          const id = deleteConfirm
          setDeleteConfirm(undefined)
          if (id) void mutateLifecycle('delete', id)
        }}
      />

      <ConfirmDialog
        open={Boolean(forceConfirm)}
        title={forceConfirm?.kind === 'delete' ? '强制删除？' : '强制归档？'}
        body="会话正在运行。强制操作只阻止后续唤醒，不中止当前轮；当前轮会自行收尾。"
        confirmLabel={forceConfirm?.kind === 'delete' ? '强制删除' : '强制归档'}
        danger={forceConfirm?.kind === 'delete'}
        busy={actionBusy}
        onCancel={() => setForceConfirm(undefined)}
        onConfirm={() => {
          const pending = forceConfirm
          setForceConfirm(undefined)
          if (!pending) return
          void mutateLifecycle(pending.kind, pending.id, true)
        }}
      />

      {toast && (
        <button
          className={`toast ${toast.kind}`}
          onClick={() => setToast(undefined)}
          title="点击关闭"
        >
          <Icon name={toast.kind === 'error' ? 'warning' : 'check'} size={15} />
          <span>{toast.text}</span>
        </button>
      )}
    </div>
  )
}
