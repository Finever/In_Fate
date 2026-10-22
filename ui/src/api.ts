import type {
  AgentRunInfo,
  SessionInfo,
  TurnResponse,
  UiApproval,
  UiPayloadSlice,
  UiSessionStats,
  UiTimelineItem,
  UiTurnMeta,
} from './types'

const TOKEN_KEY = 'if-ui-token'

export function getToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl)
    return fromUrl
  }
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')

  const response = await fetch(path, { ...init, headers })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { error?: string }
      if (body.error) detail = body.error
    } catch {
      // 非 JSON 错误
    }
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

export const api = {
  async sessions(): Promise<SessionInfo[]> {
    const body = await request<{ sessions: SessionInfo[] }>('/api/sessions')
    return body.sessions
  },

  async turns(sessionId: string): Promise<UiTurnMeta[]> {
    const body = await request<{ turns: UiTurnMeta[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/turns`)
    return body.turns
  },

  async turnItems(sessionId: string, turn: number): Promise<UiTimelineItem[]> {
    const body = await request<TurnResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/turns/${turn}`,
    )
    return body.items
  },

  async payload(sessionId: string, input: {
    ref?: string
    eventId?: string
    offset?: number
    limit?: number
  }): Promise<UiPayloadSlice> {
    const params = new URLSearchParams()
    if (input.ref) params.set('ref', input.ref)
    if (input.eventId) params.set('eventId', input.eventId)
    if (input.offset !== undefined) params.set('offset', String(input.offset))
    if (input.limit !== undefined) params.set('limit', String(input.limit))
    return request<UiPayloadSlice>(
      `/api/sessions/${encodeURIComponent(sessionId)}/payload?${params.toString()}`,
    )
  },

  async stats(sessionId: string): Promise<UiSessionStats> {
    return request<UiSessionStats>(`/api/sessions/${encodeURIComponent(sessionId)}/stats`)
  },

  async agents(): Promise<AgentRunInfo[]> {
    const body = await request<{ agents: AgentRunInfo[] }>('/api/agents')
    return body.agents
  },

  async approvals(sessionId?: string): Promise<UiApproval[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const body = await request<{ approvals: UiApproval[] }>(`/api/approvals${query}`)
    return body.approvals
  },

  async respondApproval(approvalId: string, approved: boolean): Promise<void> {
    await request(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    })
  },

  async sendMessage(sessionId: string, text: string): Promise<unknown> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  },
}
