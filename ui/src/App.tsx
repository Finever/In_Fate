import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken } from './api'
import { TurnCache } from './cache'
import { Timeline } from './components/Timeline'
import type {
  AgentRunInfo,
  SessionInfo,
  UiApproval,
  UiSessionStats,
  UiTurnMeta,
} from './types'

function TokenGate({ onReady }: { onReady: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="gate">
      <div className="gate-card">
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
        <button
          onClick={() => {
            if (!value.trim()) return
            setToken(value.trim())
            onReady(value.trim())
          }}
        >
          进入
        </button>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function App() {
  const [token, setTokenState] = useState(getToken())
  if (!token) return <TokenGate onReady={setTokenState} />
  return <Workspace />
}

function Workspace() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [turns, setTurns] = useState<UiTurnMeta[]>([])
  const [stats, setStats] = useState<UiSessionStats>()
  const [agents, setAgents] = useState<AgentRunInfo[]>([])
  const [approvals, setApprovals] = useState<UiApproval[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')

  const cache = useMemo(() => new TurnCache(), [sessionId])

  useEffect(() => {
    void api.sessions()
      .then(next => {
        setSessions(next)
        setSessionId(current => current ?? next[0]?.id)
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  const load = useCallback(async (id: string): Promise<void> => {
    const [nextTurns, nextStats, nextAgents, nextApprovals] = await Promise.all([
      api.turns(id),
      api.stats(id),
      api.agents(),
      api.approvals(id),
    ])
    // 只有最新一轮可能还在变化；旧轮保持缓存。
    const latest = nextTurns.at(-1)?.turn
    if (latest) cache.delete(latest)
    setTurns(nextTurns)
    setStats(nextStats)
    setAgents(nextAgents)
    setApprovals(nextApprovals)
    setRefreshKey(key => key + 1)
    setError(undefined)
  }, [cache])

  useEffect(() => {
    if (!sessionId) return
    cache.clear()
    void load(sessionId).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [cache, load, sessionId])

  useEffect(() => {
    if (!sessionId) return
    const timer = window.setInterval(() => {
      void load(sessionId).catch(() => undefined)
    }, 8000)
    return () => window.clearInterval(timer)
  }, [load, sessionId])

  async function send(): Promise<void> {
    if (!sessionId || !draft.trim() || sending) return
    const text = draft.trim()
    setDraft('')
    setSending(true)
    setError(undefined)
    try {
      await api.sendMessage(sessionId, text)
      await load(sessionId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">IF</span>
          <div>
            <div className="brand-name">In_Fate</div>
            <div className="brand-sub">local · windowed history</div>
          </div>
        </div>

        <section>
          <h2>会话</h2>
          <div className="session-list">
            {sessions.map(session => (
              <button
                key={session.id}
                className={`session-item${session.id === sessionId ? ' active' : ''}`}
                onClick={() => setSessionId(session.id)}
              >
                <span>{session.id}</span>
                <small>{formatBytes(session.bytes)}</small>
              </button>
            ))}
          </div>
        </section>

        {stats && (
          <section className="stat-card">
            <h2>占用</h2>
            <div className="stat-row"><span>事件</span><b>{stats.events}</b></div>
            <div className="stat-row"><span>轮</span><b>{stats.turns}</b></div>
            <div className="stat-row"><span>压缩</span><b>{stats.compacted}</b></div>
            <div className="stat-row"><span>日志</span><b>{formatBytes(stats.fileBytes)}</b></div>
          </section>
        )}

        <section>
          <h2>子 agent</h2>
          {agents.length === 0 && <div className="muted">没有</div>}
          {agents.slice(0, 8).map(agent => (
            <div key={agent.id} className="agent-row">
              <span className={`dot ${agent.status}`} />
              <span>{agent.preset}</span>
              <small>{agent.status}</small>
            </div>
          ))}
        </section>

        <section>
          <h2>待审批</h2>
          {approvals.length === 0 && <div className="muted">没有</div>}
          {approvals.map(approval => (
            <div key={approval.approvalId} className="approval">
              <div className="approval-tool">{approval.toolName}</div>
              <pre>{JSON.stringify(approval.input, null, 2)}</pre>
              <div className="approval-actions">
                <button onClick={() => {
                  void api.respondApproval(approval.approvalId, true).then(async () => {
                    if (sessionId) await load(sessionId)
                  })
                }}>允许</button>
                <button className="danger" onClick={() => {
                  void api.respondApproval(approval.approvalId, false).then(async () => {
                    if (sessionId) await load(sessionId)
                  })
                }}>拒绝</button>
              </div>
            </div>
          ))}
        </section>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">SESSION</div>
            <h1>{sessionId ?? '选择会话'}</h1>
          </div>
          <div className="top-actions">
            <button onClick={() => sessionId && void load(sessionId)}>刷新</button>
          </div>
        </header>

        {error && <div className="banner error">{error}</div>}

        {sessionId && (
          <Timeline
            sessionId={sessionId}
            turns={turns}
            cache={cache}
            refreshKey={refreshKey}
          />
        )}

        <footer className="composer">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="对她说点什么…"
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button disabled={sending || !draft.trim()} onClick={() => void send()}>
            {sending ? '运行中…' : '发送'}
          </button>
        </footer>
      </main>
    </div>
  )
}
