import { formatDateTime, oneLine, shortId } from '../lib/format'
import type { AgentRunInfo } from '../types'
import { Badge, EmptyState, LifecycleBadge } from './Ui'

function statusTone(status: string): 'mint' | 'warn' | 'danger' | 'muted' {
  if (status === 'completed') return 'mint'
  if (status === 'running' || status === 'queued') return 'warn'
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 'danger'
  return 'muted'
}

export function AgentsPanel({ agents }: { agents: AgentRunInfo[] }) {
  if (agents.length === 0) {
    return (
      <EmptyState
        icon="agents"
        title="没有子 agent"
        body="派活之后，运行状态、预设和终态摘要会出现在这里。"
      />
    )
  }

  return (
    <div className="agent-list">
      {agents.map(agent => (
        <article key={agent.id} className={`agent-card lifecycle-${agent.lifecycle}`}>
          <header>
            <span className={`status-dot ${agent.status}`} />
            <span className="agent-preset">{agent.preset || shortId(agent.id, 18)}</span>
            <Badge tone={statusTone(agent.status)}>{agent.status}</Badge>
            {agent.lifecycle !== 'active' && <LifecycleBadge lifecycle={agent.lifecycle} />}
          </header>
          {agent.summary && <p>{oneLine(agent.summary, 220)}</p>}
          <footer>
            <span title={agent.id}>{shortId(agent.id, 20)}</span>
            <span>{formatDateTime(agent.updatedAt)}</span>
          </footer>
        </article>
      ))}
    </div>
  )
}
