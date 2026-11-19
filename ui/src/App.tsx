import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { api, getToken, setToken } from './api'
import { AddMainAgentDialog } from './components/AddMainAgentDialog'
import { AgentPanel } from './components/AgentPanel'
import { ApprovalDialog } from './components/ApprovalDialog'
import { FrameBoot, FrameCenter, FrameGate, FrameRight, FrameSidebar } from './components/Framework'
import type { MainAgentListItem } from './components/Framework'
import { PromptDialog } from './components/PromptDialog'
import { SessionView } from './components/SessionView'
import { SettingsDialog } from './components/SettingsDialog'
import { TitleBar } from './components/TitleBar'
import { useApprovals } from './hooks/useApprovals'
import { useWorkspace } from './hooks/useWorkspace'
import type { SessionInfo } from './types'

const SELECTED_KEY = 'if-selected-session'
const LEFT_KEY = 'if-left-width'
const RIGHT_KEY = 'if-right-width'
const LEFT_DEFAULT = 280
const RIGHT_DEFAULT = 340
const LEFT_MIN = 200
const LEFT_MAX = 520
const RIGHT_MIN = 260
const RIGHT_MAX = 640
const CENTER_MIN = 360
const NARROW = 900
const FALLBACK_AGENT = 'main'

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function storedWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  return clampWidth(Number.isFinite(raw) && raw > 0 ? raw : fallback, min, max)
}

function sessionAgentId(session: SessionInfo): string {
  return session.agentId ?? FALLBACK_AGENT
}

export default function App() {
  const [token, setTokenState] = useState(getToken())
  if (!token) {
    return (
      <FrameGate
        onReady={value => {
          setToken(value)
          setTokenState(value)
        }}
      />
    )
  }
  return <Desktop />
}

function Desktop() {
  const workspace = useWorkspace()
  const approvalCenter = useApprovals()
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('session')
    return fromUrl ?? localStorage.getItem(SELECTED_KEY) ?? undefined
  })
  const [rightOpen, setRightOpen] = useState(false)
  const [agentFilter, setAgentFilter] = useState('all')
  const [leftWidth, setLeftWidth] = useState(() =>
    storedWidth(LEFT_KEY, LEFT_DEFAULT, LEFT_MIN, LEFT_MAX))
  const [rightWidth, setRightWidth] = useState(() =>
    storedWidth(RIGHT_KEY, RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX))
  const [creating, setCreating] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [addAgentOpen, setAddAgentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingAgentId, setPendingAgentId] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const dragRef = useRef<{
    side: 'left' | 'right'
    startX: number
    startWidth: number
    otherWidth: number
  } | null>(null)

  const homeSessions = useMemo(
    () => workspace.sessions.filter(item =>
      item.lifecycle !== 'deleted' && item.kind !== 'agent'),
    [workspace.sessions],
  )

  const agentItems = useMemo<MainAgentListItem[]>(() => workspace.mainAgents
    .map(agent => ({
      id: agent.id,
      name: agent.name,
      sessionCount: homeSessions.filter(session =>
        sessionAgentId(session) === agent.id).length,
    })),
  [homeSessions, workspace.mainAgents])

  const filteredSessions = useMemo(() => {
    if (agentFilter === 'all') return homeSessions
    return homeSessions.filter(session => sessionAgentId(session) === agentFilter)
  }, [agentFilter, homeSessions])

  const selectedSession = filteredSessions.find(item => item.id === selectedId)
  const panelAgentId = agentFilter !== 'all'
    ? agentFilter
    : selectedSession?.agentId
      ?? workspace.mainAgents.find(agent => agent.id === FALLBACK_AGENT)?.id
      ?? workspace.mainAgents[0]?.id
  const panelAgent = workspace.mainAgents.find(agent => agent.id === panelAgentId)
  const panelSessions = useMemo(
    () => panelAgentId
      ? homeSessions.filter(session => sessionAgentId(session) === panelAgentId)
      : [],
    [homeSessions, panelAgentId],
  )
  const selectedAgent = selectedSession
    ? workspace.mainAgents.find(agent => agent.id === sessionAgentId(selectedSession))
    : undefined

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
    else localStorage.removeItem(SELECTED_KEY)
  }, [selectedId])

  useEffect(() => {
    localStorage.setItem(LEFT_KEY, String(Math.round(leftWidth)))
  }, [leftWidth])

  useEffect(() => {
    localStorage.setItem(RIGHT_KEY, String(Math.round(rightWidth)))
  }, [rightWidth])

  useEffect(() => {
    if (workspace.loading) return
    if (agentFilter === 'all') return
    if (workspace.mainAgents.some(agent => agent.id === agentFilter)) return
    setAgentFilter('all')
  }, [agentFilter, workspace.mainAgents])

  useEffect(() => {
    if (!pendingAgentId) return
    if (!workspace.mainAgents.some(agent => agent.id === pendingAgentId)) return
    setAgentFilter(pendingAgentId)
    setPendingAgentId(undefined)
    setRightOpen(true)
  }, [pendingAgentId, workspace.mainAgents])

  useEffect(() => {
    if (workspace.loading) return
    if (selectedId && filteredSessions.some(item => item.id === selectedId)) return
    const first = filteredSessions.find(item => item.lifecycle === 'active')
      ?? filteredSessions[0]
    setSelectedId(first?.id)
  }, [filteredSessions, selectedId, workspace.loading])

  useEffect(() => {
    const adapt = (): void => {
      if (window.innerWidth <= NARROW) return
      const openRight = rightOpen ? rightWidth : 0
      const maxLeft = Math.max(
        LEFT_MIN,
        Math.min(LEFT_MAX, window.innerWidth - openRight - CENTER_MIN),
      )
      setLeftWidth(value => clampWidth(value, LEFT_MIN, maxLeft))
      const maxRight = Math.max(
        RIGHT_MIN,
        Math.min(RIGHT_MAX, window.innerWidth - leftWidth - CENTER_MIN),
      )
      setRightWidth(value => clampWidth(value, RIGHT_MIN, maxRight))
    }
    window.addEventListener('resize', adapt)
    return () => window.removeEventListener('resize', adapt)
  }, [leftWidth, rightOpen, rightWidth])

  useEffect(() => () => {
    document.body.classList.remove('fw-resizing')
  }, [])

  const startResize = useCallback((
    side: 'left' | 'right',
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0 || window.innerWidth <= NARROW) return
    event.preventDefault()
    dragRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === 'left' ? leftWidth : rightWidth,
      otherWidth: side === 'left' ? (rightOpen ? rightWidth : 0) : leftWidth,
    }
    document.body.classList.add('fw-resizing')

    const onMove = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const delta = moveEvent.clientX - drag.startX
      if (drag.side === 'left') {
        const max = Math.max(
          LEFT_MIN,
          Math.min(LEFT_MAX, window.innerWidth - drag.otherWidth - CENTER_MIN),
        )
        setLeftWidth(clampWidth(drag.startWidth + delta, LEFT_MIN, max))
      } else {
        const max = Math.max(
          RIGHT_MIN,
          Math.min(RIGHT_MAX, window.innerWidth - drag.otherWidth - CENTER_MIN),
        )
        setRightWidth(clampWidth(drag.startWidth - delta, RIGHT_MIN, max))
      }
    }

    const finish = (): void => {
      dragRef.current = null
      document.body.classList.remove('fw-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('blur', finish)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('blur', finish)
  }, [leftWidth, rightOpen, rightWidth])

  const toggleRight = useCallback((): void => {
    setRightOpen(value => {
      if (!value && window.innerWidth > NARROW) {
        const maxLeft = Math.max(
          LEFT_MIN,
          Math.min(LEFT_MAX, window.innerWidth - rightWidth - CENTER_MIN),
        )
        setLeftWidth(current => clampWidth(current, LEFT_MIN, maxLeft))
        const maxRight = Math.max(
          RIGHT_MIN,
          Math.min(RIGHT_MAX, window.innerWidth - leftWidth - CENTER_MIN),
        )
        setRightWidth(current => clampWidth(current, RIGHT_MIN, maxRight))
      }
      return !value
    })
  }, [leftWidth, rightWidth])

  const create = useCallback((): void => {
    if (creating) return
    setNewSessionOpen(true)
  }, [creating])

  const submitNewSession = useCallback(async (desired: string): Promise<void> => {
    const targetAgent = agentFilter !== 'all'
      ? agentFilter
      : selectedSession?.agentId
        ?? workspace.mainAgents.find(agent => agent.id === FALLBACK_AGENT)?.id
    setCreating(true)
    setActionError(undefined)
    try {
      const id = await api.createSession(targetAgent, desired || undefined)
      await workspace.refresh(true)
      setSelectedId(id)
      setNewSessionOpen(false)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    } finally {
      setCreating(false)
    }
  }, [agentFilter, selectedSession, workspace])

  const addMainAgent = useCallback(async (
    input: { id: string; name: string },
  ): Promise<void> => {
    const agent = await api.createMainAgent(input)
    setAddAgentOpen(false)
    setPendingAgentId(agent.id)
    setAgentFilter('all')
    void workspace.refresh(true)
  }, [workspace])

  if (workspace.loading && workspace.sessions.length === 0) return <FrameBoot />

  const shellStyle = {
    '--fw-left-w': `${Math.round(leftWidth)}px`,
    '--fw-right-w': `${Math.round(rightWidth)}px`,
  } as CSSProperties

  return (
    <div
      className={`fw-shell${rightOpen ? ' is-right-open' : ''}`}
      style={shellStyle}
    >
      <TitleBar onSettings={() => setSettingsOpen(true)} />
      <FrameSidebar
        sessions={filteredSessions}
        totalSessions={homeSessions.length}
        agents={agentItems}
        selectedAgentId={agentFilter}
        selectedId={selectedId}
        onSelect={id => {
          setSelectedId(id)
          setActionError(undefined)
        }}
        onSelectAgent={id => {
          setPendingAgentId(undefined)
          setAgentFilter(id)
          setActionError(undefined)
        }}
        onAddAgent={() => setAddAgentOpen(true)}
        onResizeStart={event => startResize('left', event)}
      />

      <FrameCenter
        session={selectedSession}
        rightOpen={rightOpen}
        error={actionError ?? workspace.error}
        onToggleRight={toggleRight}
        onCreate={() => void create()}
      >
        {selectedSession && (
          <SessionView
            key={selectedSession.id}
            session={selectedSession}
            agent={selectedAgent}
            onSent={() => void workspace.refresh(true)}
          />
        )}
      </FrameCenter>

      <FrameRight
        open={rightOpen}
        onResizeStart={event => startResize('right', event)}
      >
        <AgentPanel
          agentId={panelAgentId}
          agent={panelAgent}
          sessions={panelSessions}
          onSelectSession={id => {
            setSelectedId(id)
            setActionError(undefined)
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onChanged={() => void workspace.refresh(true)}
          onClose={() => setRightOpen(false)}
        />
      </FrameRight>

      {newSessionOpen && (
        <PromptDialog
          title="新建会话"
          label="会话 ID"
          placeholder="留空自动生成；可用字母、数字、点、下划线、连字符"
          allowEmpty
          confirmLabel="创建"
          onClose={() => setNewSessionOpen(false)}
          onSubmit={submitNewSession}
        />
      )}

      {addAgentOpen && (
        <AddMainAgentDialog
          onClose={() => setAddAgentOpen(false)}
          onSubmit={addMainAgent}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      <ApprovalDialog
        approvals={approvalCenter.approvals}
        proposals={approvalCenter.proposals}
        sessions={workspace.sessions}
        error={approvalCenter.error}
        onRefresh={approvalCenter.refresh}
      />
    </div>
  )
}
