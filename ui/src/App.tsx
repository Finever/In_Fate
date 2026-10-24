import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken } from './api'
import { AgentsPanel } from './components/AgentsPanel'
import { ApprovalsPanel } from './components/ApprovalsPanel'
import { ChatPane } from './components/ChatPane'
import { CommandPalette } from './components/CommandPalette'
import { Icon } from './components/Icon'
import { Inspector } from './components/Inspector'
import { RightPanel } from './components/RightPanel'
import { Sidebar } from './components/Sidebar'
import { Button, ConfirmDialog, Spinner } from './components/Ui'
import { useSession } from './hooks/useSession'
import { useWorkspace } from './hooks/useWorkspace'
import { sessionDisplayTitle } from './lib/sessions'

const SELECTED_KEY = 'if-selected-session'
const SIDEBAR_KEY = 'if-sidebar'

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
type RightMode = 'details' | 'approvals' | 'agents'

function Desktop() {
  const workspace = useWorkspace()
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('session')
    return fromUrl ?? localStorage.getItem(SELECTED_KEY) ?? undefined
  })
  const session = useSession(selectedId)

  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (window.innerWidth <= 900) return false
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed'
  })
  const [showArchived, setShowArchived] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [rightPanel, setRightPanel] = useState<RightMode | undefined>(() => {
    const panel = new URLSearchParams(window.location.search).get('panel')
    return panel === 'details' || panel === 'approvals' || panel === 'agents' ? panel : undefined
  })
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

  const sessionApprovals = useMemo(() => workspace.approvals.filter(item =>
    item.sessionId === selectedId), [selectedId, workspace.approvals])

  const agentsRunning = workspace.agents.filter(agent =>
    agent.status === 'running' || agent.status === 'queued').length

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text })
  }, [])

  useEffect(() => {
    if (workspace.error) setToast({ kind: 'error', text: workspace.error })
  }, [workspace.error])

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
    else localStorage.removeItem(SELECTED_KEY)
  }, [selectedId])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? 'open' : 'closed')
  }, [sidebarOpen])

  useEffect(() => {
    if (workspace.loading) return
    if (selectedId && !workspace.sessions.some(item => item.id === selectedId)) {
      setSelectedId(undefined)
    }
  }, [selectedId, workspace.loading, workspace.sessions])

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
    setRightPanel(undefined)
    setCommandOpen(false)
    if (window.innerWidth <= 900) setSidebarOpen(false)
  }, [])

  const create = useCallback(async (): Promise<void> => {
    setActionBusy(true)
    try {
      const id = await api.createSession()
      await workspace.refresh(true)
      setSelectedId(id)
      setQuery('')
      setRightPanel(undefined)
      setCommandOpen(false)
      if (window.innerWidth <= 900) setSidebarOpen(false)
      notify('ok', '已新建会话')
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActionBusy(false)
    }
  }, [notify, workspace])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(value => !value)
        return
      }
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void create()
        return
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setRightPanel(undefined)
        if (window.innerWidth <= 900) setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [create])

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
      if (kind === 'delete' && id === selectedId) {
        setSelectedId(undefined)
        setRightPanel(undefined)
      }
      await Promise.all([
        workspace.refresh(true),
        id === selectedId ? session.refresh() : Promise.resolve(),
      ])
      notify('ok', kind === 'archive' ? '已归档' : kind === 'unarchive' ? '已恢复' : '已删除')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (/running|busy|ESESSIONBUSY/i.test(message) && !force) {
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

  if (workspace.loading && workspace.sessions.length === 0) {
    return (
      <div className="boot">
        <span className="brand-mark">IF</span>
        <Spinner label="载入工作区…" />
      </div>
    )
  }

  const rightOpen = Boolean(rightPanel && (rightPanel !== 'details' || selectedSession))
  const rightTitle = rightPanel === 'details'
    ? '会话详情'
    : rightPanel === 'approvals'
      ? '待审批'
      : '子 agent'
  const selectedTitle = selectedSession ? sessionDisplayTitle(selectedSession) : 'In_Fate'

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}${rightOpen ? ' right-open' : ''}`}>
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭会话列表"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {sidebarOpen && (
        <Sidebar
          sessions={visibleSessions}
          links={workspace.links}
          selectedId={selectedId}
          approvals={workspace.approvals.length}
          agentsRunning={agentsRunning}
          online={!workspace.error}
          refreshing={workspace.refreshing || session.loading}
          showArchived={showArchived}
          showDeleted={showDeleted}
          query={query}
          busy={actionBusy}
          onQuery={setQuery}
          onSelect={select}
          onCreate={() => void create()}
          onRefresh={() => void refreshAll()}
          onToggleArchived={() => setShowArchived(value => !value)}
          onToggleDeleted={() => setShowDeleted(value => !value)}
          onArchive={id => void mutateLifecycle('archive', id)}
          onUnarchive={id => void mutateLifecycle('unarchive', id)}
          onDelete={setDeleteConfirm}
          onApprovals={() => setRightPanel('approvals')}
          onAgents={() => setRightPanel('agents')}
          onCommand={() => setCommandOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}

      <ChatPane
        session={selectedSession}
        title={selectedTitle}
        inspection={session.inspection}
        turns={session.turns}
        cache={session.cache}
        revision={session.revision}
        approvals={sessionApprovals}
        loading={session.loading}
        error={session.error}
        sending={sending}
        onCreate={() => void create()}
        onSend={send}
        onToggleSidebar={() => setSidebarOpen(value => !value)}
        onRefresh={() => void refreshAll()}
        onDetails={() => setRightPanel('details')}
        onArchive={() => {
          if (selectedSession) void mutateLifecycle('archive', selectedSession.id)
        }}
        onUnarchive={() => {
          if (selectedSession) void mutateLifecycle('unarchive', selectedSession.id)
        }}
        onDelete={() => {
          if (selectedSession) setDeleteConfirm(selectedSession.id)
        }}
        onOpenApprovals={() => setRightPanel('approvals')}
      />

      <RightPanel
        open={rightOpen}
        title={rightTitle}
        onClose={() => setRightPanel(undefined)}
      >
        {rightPanel === 'details' && selectedSession && (
          <Inspector
            session={selectedSession}
            inspection={session.inspection}
            stats={session.stats}
            links={workspace.links}
            sessions={workspace.sessions}
            busy={actionBusy}
            onArchive={() => void mutateLifecycle('archive', selectedSession.id)}
            onUnarchive={() => void mutateLifecycle('unarchive', selectedSession.id)}
            onDelete={() => setDeleteConfirm(selectedSession.id)}
            onCloseLink={linkId => void closeLink(linkId)}
          />
        )}
        {rightPanel === 'approvals' && (
          <ApprovalsPanel
            approvals={workspace.approvals}
            busy={actionBusy}
            onRespond={(id, approved) => void respondApproval(id, approved)}
          />
        )}
        {rightPanel === 'agents' && <AgentsPanel agents={workspace.agents} />}
      </RightPanel>

      <CommandPalette
        open={commandOpen}
        sessions={workspace.sessions}
        onClose={() => setCommandOpen(false)}
        onSelect={select}
        onCreate={() => void create()}
        onApprovals={() => setRightPanel('approvals')}
        onAgents={() => setRightPanel('agents')}
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
          type="button"
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
