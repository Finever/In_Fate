import type {
  AgentRunInfo,
  AgentSettingsUpdate,
  AgentSummary,
  MainAgentIdentity,
  MainAgentInfo,
  ModelConfig,
  ModelProviderInput,
  SaveModelCardInput,
  SaveModelConfigInput,
  LogSearchResult,
  LogTree,
  LogViewPage,
  MemoryDocument,
  MemoryFileSummary,
  MemoryIndexList,
  MemoryProposal,
  MemorySearchHit,
  MemoryValidationIssue,
  SessionInfo,
  SessionInspection,
  SessionLifecycleRecord,
  SessionLink,
  ToolView,
  TurnResponse,
  UiApproval,
  UiPayloadSlice,
  UiSessionStats,
  UiTimelineItem,
  UiTurnMeta,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly agentId?: string
  readonly issues?: MemoryValidationIssue[]

  constructor(
    message: string,
    status = 0,
    code?: string,
    agentId?: string,
    issues?: MemoryValidationIssue[],
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.agentId = agentId
    this.issues = issues
  }
}

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

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')

  const response = await fetch(path, { ...init, headers })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    let code: string | undefined
    let agentId: string | undefined
    let issues: MemoryValidationIssue[] | undefined
    try {
      const body = await response.json() as {
        error?: string
        code?: string
        agentId?: string
        issues?: MemoryValidationIssue[]
      }
      if (body.error) detail = body.error
      code = body.code
      agentId = body.agentId
      if (Array.isArray(body.issues)) issues = body.issues
    } catch {
      // 非 JSON 错误
    }
    throw new ApiError(detail, response.status, code, agentId, issues)
  }
  return response.json() as Promise<T>
}

function query(values: { includeArchived?: boolean; includeDeleted?: boolean }): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, '1')
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export interface WorkspaceQuery {
  includeArchived?: boolean
  includeDeleted?: boolean
}

export const api = {
  async sessions(options: WorkspaceQuery = {}): Promise<SessionInfo[]> {
    const body = await request<{ sessions: SessionInfo[] }>(`/api/sessions${query(options)}`)
    return body.sessions
  },

  async createSession(agentId?: string): Promise<string> {
    const body = await request<{ sessionId: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        createdBy: 'user',
        reason: 'ui',
        ...(agentId ? { agentId } : {}),
      }),
    })
    return body.sessionId
  },

  async inspect(sessionId: string): Promise<SessionInspection> {
    return request<SessionInspection>(
      `/api/sessions/${encodeURIComponent(sessionId)}/inspect`,
    )
  },

  async turns(sessionId: string): Promise<UiTurnMeta[]> {
    const body = await request<{ turns: UiTurnMeta[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
    )
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

  async agents(options: WorkspaceQuery = {}): Promise<AgentRunInfo[]> {
    const body = await request<{ agents: AgentRunInfo[] }>(`/api/agents${query(options)}`)
    return body.agents
  },

  async modelConfig(): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>('/api/model-config')
    return body.config
  },

  async saveModelConfig(input: SaveModelConfigInput): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>('/api/model-config', {
      method: 'POST',
      body: JSON.stringify({
        provider: input.provider,
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      }),
    })
    return body.config
  },

  async addModelProvider(input: ModelProviderInput): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>('/api/model-config/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return body.config
  },

  async saveModelCard(input: SaveModelCardInput): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>(
      `/api/model-config/models/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.model)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...(input.contextWindow !== undefined
            ? { contextWindow: input.contextWindow }
            : {}),
          ...(input.maxOutputTokens !== undefined
            ? { maxOutputTokens: input.maxOutputTokens }
            : {}),
          ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
        }),
      },
    )
    return body.config
  },

  async mainAgents(): Promise<AgentSummary[]> {
    const body = await request<{ agents: AgentSummary[] }>('/api/main-agents')
    return body.agents
  },

  async agentSummary(agentId: string): Promise<AgentSummary> {
    const body = await request<{ agent: AgentSummary }>(
      `/api/main-agents/${encodeURIComponent(agentId)}`,
    )
    return body.agent
  },

  async updateAgentSettings(
    agentId: string,
    input: AgentSettingsUpdate,
  ): Promise<AgentSummary> {
    const body = await request<{ agent: AgentSummary }>(
      `/api/main-agents/${encodeURIComponent(agentId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    return body.agent
  },

  async createMainAgent(input: { id: string; name: string }): Promise<AgentSummary> {
    const body = await request<{ agent: MainAgentInfo }>('/api/main-agents', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return {
      id: body.agent.id,
      name: body.agent.name,
      hasManifest: true,
      modelConfigured: false,
      subagentModels: [],
      availablePresets: [],
      tools: {},
    }
  },

  async tools(agentId?: string): Promise<ToolView[]> {
    const suffix = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
    const body = await request<{ tools: ToolView[] }>(`/api/tools${suffix}`)
    return body.tools
  },

  async updateTool(
    name: string,
    input: { enabled?: boolean; approval?: 'auto' | 'required' },
  ): Promise<ToolView[]> {
    const body = await request<{ tools: ToolView[] }>(
      `/api/tools/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    return body.tools
  },

  async mainAgentIdentity(agentId: string): Promise<MainAgentIdentity> {
    const body = await request<{ identity: MainAgentIdentity }>(
      `/api/main-agents/${encodeURIComponent(agentId)}/identity`,
    )
    return body.identity
  },

  async writeMainAgentSlot(
    agentId: string,
    slotId: string,
    content: string,
  ): Promise<{ path: string; backup: string }> {
    const body = await request<{ result: { path: string; backup: string } }>(
      `/api/main-agents/${encodeURIComponent(agentId)}/identity/${encodeURIComponent(slotId)}`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    )
    return body.result
  },

  async memorySearch(query: string, limit = 20): Promise<MemorySearchHit[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const body = await request<{ hits: MemorySearchHit[] }>(`/api/memory/search?${params.toString()}`)
    return body.hits
  },

  async memoryRead(target: string): Promise<MemoryDocument> {
    const params = new URLSearchParams({ target })
    const body = await request<{ document: MemoryDocument }>(`/api/memory/read?${params.toString()}`)
    return body.document
  },

  async memoryIndex(): Promise<MemoryFileSummary[]> {
    const body = await request<{ files: MemoryFileSummary[] }>('/api/memory/index')
    return body.files
  },

  async memoryIndexList(): Promise<MemoryIndexList> {
    const body = await request<{ index: MemoryIndexList }>('/api/memory/indexlist')
    return body.index
  },

  async reindexMemory(): Promise<MemoryIndexList> {
    const body = await request<{ index: MemoryIndexList }>('/api/memory/reindex', {
      method: 'POST',
      body: '{}',
    })
    return body.index
  },

  async memoryLogTree(): Promise<LogTree> {
    return request<LogTree>('/api/memory/log/tree')
  },

  async memoryLogPage(
    day: string,
    sid: string,
    options: { offset?: number; limit?: number; jumpN?: number } = {},
  ): Promise<LogViewPage> {
    const params = new URLSearchParams({ day, sid })
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.jumpN !== undefined) params.set('n', String(options.jumpN))
    return request<LogViewPage>(`/api/memory/log/file?${params.toString()}`)
  },

  async memoryLogSearch(query: string, limit = 200): Promise<LogSearchResult> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return request<LogSearchResult>(`/api/memory/log/search?${params.toString()}`)
  },

  async saveMemoryDocument(
    target: string,
    document: MemoryDocument,
  ): Promise<{ document: MemoryDocument; warnings: MemoryValidationIssue[] }> {
    return request('/api/memory/document', {
      method: 'PUT',
      body: JSON.stringify({ target, document }),
    })
  },

  async memoryProposals(status: 'pending' | 'accepted' | 'rejected' | 'all' = 'pending'): Promise<MemoryProposal[]> {
    const params = new URLSearchParams({ status })
    const body = await request<{ proposals: MemoryProposal[] }>(`/api/memory/proposals?${params.toString()}`)
    return body.proposals
  },

  async acceptProposal(proposalId: string): Promise<unknown> {
    return request(`/api/memory/proposals/${encodeURIComponent(proposalId)}/accept`, {
      method: 'POST',
      body: '{}',
    })
  },

  async rejectProposal(proposalId: string): Promise<unknown> {
    return request(`/api/memory/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: 'POST',
      body: '{}',
    })
  },

  async approvals(sessionId?: string): Promise<UiApproval[]> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const body = await request<{ approvals: UiApproval[] }>(`/api/approvals${suffix}`)
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

  async links(sessionId?: string): Promise<SessionLink[]> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const body = await request<{ links: SessionLink[] }>(`/api/links${suffix}`)
    return body.links
  },

  async closeLink(linkId: string, reason?: string): Promise<SessionLink> {
    const body = await request<{ link: SessionLink }>(
      `/api/links/${encodeURIComponent(linkId)}/close`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    )
    return body.link
  },

  async archiveSession(sessionId: string, reason?: string): Promise<SessionLifecycleRecord> {
    const body = await request<{ session: SessionLifecycleRecord }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    )
    return body.session
  },

  async unarchiveSession(sessionId: string, reason?: string): Promise<SessionLifecycleRecord> {
    const body = await request<{ session: SessionLifecycleRecord }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/unarchive`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    )
    return body.session
  },

  async deleteSession(
    sessionId: string,
    input: { force?: boolean; reason?: string } = {},
  ): Promise<SessionLifecycleRecord> {
    const body = await request<{ session: SessionLifecycleRecord }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/delete`,
      { method: 'POST', body: JSON.stringify(input) },
    )
    return body.session
  },
}
