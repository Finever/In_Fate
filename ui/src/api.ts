import type {
  AgentRunInfo,
  AgentSettingsUpdate,
  AgentSummary,
  EmbeddingInstallJob,
  EmbeddingModelStatus,
  MainAgentIdentity,
  MainAgentIdentityBackup,
  MainAgentInfo,
  ModelBalance,
  ModelConfig,
  ModelProviderInput,
  ModelProviderModelInput,
  ModelProviderTemplate,
  PluginInfo,
  PluginListResult,
  PluginPanelContent,
  SaveModelCardInput,
  SaveModelConfigInput,
  LogSearchResult,
  LogTree,
  LogViewPage,
  MemoryDocument,
  MemoryFileSummary,
  MemoryIndexList,
  MemoryCommitStatus,
  MemoryLibraryFile,
  ResolvedMemoryPolicy,
  MemorySummaryWorkerStatus,
  MemoryLibraryNode,
  MemoryProposal,
  MemorySearchHit,
  MemoryTrashEntry,
  MemoryValidationIssue,
  PendingUpdate,
  SessionInfo,
  SessionInspection,
  SessionLifecycleRecord,
  SessionLink,
  SessionMeta,
  ToolView,
  TurnResponse,
  UiApproval,
  UpdateCheckResult,
  UpdateJob,
  UpdateStatus,
  UiPayloadSlice,
  UiSessionStats,
  UiTimelineItem,
  UiTurnMeta,
  UsageBucket,
  UsageGroupBy,
  UsageGroupRow,
  UsageLedgerStats,
  UsageOverview,
  UsageRequestPage,
  UsageTimeZone,
  UsageTimelinePoint,
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

export interface UsageQueryParams {
  from?: string
  to?: string
  providerId?: string
  modelId?: string
  agentId?: string
  sessionId?: string
  apiKeyId?: string
  source?: string
  modality?: string
  status?: string
  priority?: string
  currency?: string
  recordKind?: 'invocation' | 'legacy-aggregate' | 'rolled'
  priced?: boolean
}

const USAGE_FILTER_KEYS: ReadonlyArray<readonly [keyof UsageQueryParams, string]> = [
  ['from', 'from'],
  ['to', 'to'],
  ['providerId', 'provider'],
  ['modelId', 'model'],
  ['agentId', 'agent'],
  ['sessionId', 'session'],
  ['apiKeyId', 'key'],
  ['source', 'source'],
  ['modality', 'modality'],
  ['status', 'status'],
  ['priority', 'priority'],
  ['currency', 'currency'],
  ['recordKind', 'recordKind'],
]

function usageQuery(
  params: UsageQueryParams,
  extra: { [key: string]: string | number | undefined } = {},
): string {
  const search = new URLSearchParams()
  for (const [field, key] of USAGE_FILTER_KEYS) {
    const value = params[field]
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  if (params.priced !== undefined) search.set('priced', params.priced ? 'true' : 'false')
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  async sessions(options: WorkspaceQuery = {}): Promise<SessionInfo[]> {
    const body = await request<{ sessions: SessionInfo[] }>(`/api/sessions${query(options)}`)
    return body.sessions
  },

  async createSession(agentId?: string, sessionId?: string): Promise<string> {
    const body = await request<{ sessionId: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        ...(sessionId?.trim() ? { id: sessionId.trim() } : {}),
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

  async embeddingModels(): Promise<EmbeddingModelStatus[]> {
    const body = await request<{ models: EmbeddingModelStatus[] }>('/api/local-models/embeddings')
    return body.models
  },

  async startEmbeddingInstall(
    id: string,
    mirror = true,
  ): Promise<EmbeddingInstallJob> {
    const body = await request<{ job: EmbeddingInstallJob }>(
      `/api/local-models/embeddings/${encodeURIComponent(id)}/install`,
      { method: 'POST', body: JSON.stringify({ mirror }) },
    )
    return body.job
  },

  async embeddingInstallJob(id: string): Promise<EmbeddingInstallJob> {
    const body = await request<{ job: EmbeddingInstallJob }>(
      `/api/local-models/jobs/${encodeURIComponent(id)}`,
    )
    return body.job
  },

  async activateEmbeddingModel(id: string): Promise<EmbeddingModelStatus> {
    const body = await request<{ model: EmbeddingModelStatus }>(
      `/api/local-models/embeddings/${encodeURIComponent(id)}/activate`,
      { method: 'POST' },
    )
    return body.model
  },

  async removeEmbeddingModel(id: string): Promise<EmbeddingModelStatus[]> {
    const body = await request<{ models: EmbeddingModelStatus[] }>(
      `/api/local-models/embeddings/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    return body.models
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
        ...(input.format !== undefined ? { format: input.format } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      }),
    })
    return body.config
  },

  async addModelApiKey(
    provider: string,
    key: string,
    input: { name?: string; isEnabled?: boolean } = {},
  ): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/api-keys`,
      {
        method: 'POST',
        body: JSON.stringify({
          key,
          ...(input.name?.trim() ? { name: input.name.trim() } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        }),
      },
    )
    return body.config
  },

  async revealModelApiKey(provider: string, keyId: string): Promise<string> {
    const body = await request<{ key: string }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/api-keys/${encodeURIComponent(keyId)}`,
    )
    return body.key
  },

  async removeModelApiKey(provider: string, keyId: string): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
    )
    return body.config
  },

  async updateModelApiKey(
    provider: string,
    keyId: string,
    input: { name?: string; isEnabled?: boolean },
  ): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    return body.config
  },

  async addModelProvider(input: ModelProviderInput): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>('/api/model-config/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return body.config
  },

  async modelProviderTemplates(): Promise<ModelProviderTemplate[]> {
    const body = await request<{ providers: ModelProviderTemplate[] }>(
      '/api/model-config/templates',
    )
    return body.providers
  },

  async removeModelProvider(provider: string): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
    )
    return body.config
  },

  async probeModelProvider(
    provider: string,
    input: { apiKey?: string; baseUrl?: string; format?: string } = {},
  ): Promise<{ models: string[] }> {
    return request<{ models: string[] }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/probe`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  },

  async addProviderModels(
    provider: string,
    models: ModelProviderModelInput[],
  ): Promise<ModelConfig> {
    const body = await request<{ config: ModelConfig }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/models`,
      { method: 'POST', body: JSON.stringify({ models }) },
    )
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
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
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
      prefillSupported: false,
      subagentModels: [],
      availablePresets: [],
      tools: {},
      sessionCount: 0,
      deletable: true,
    }
  },

  async deleteMainAgent(agentId: string): Promise<{ id: string; trash: string[] }> {
    const body = await request<{ deleted: { id: string; trash: string[] } }>(
      `/api/main-agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' },
    )
    return body.deleted
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

  async plugins(): Promise<PluginListResult> {
    return request<PluginListResult>('/api/plugins')
  },

  async enablePlugin(id: string): Promise<PluginInfo> {
    const body = await request<{ plugin: PluginInfo }>(
      `/api/plugins/${encodeURIComponent(id)}/enable`,
      { method: 'POST' },
    )
    return body.plugin
  },

  async disablePlugin(id: string): Promise<PluginInfo> {
    const body = await request<{ plugin: PluginInfo }>(
      `/api/plugins/${encodeURIComponent(id)}/disable`,
      { method: 'POST' },
    )
    return body.plugin
  },

  async pluginPanel(pluginId: string, panelId: string): Promise<PluginPanelContent> {
    const body = await request<{ panel: PluginPanelContent }>(
      `/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}`,
    )
    return body.panel
  },

  async modelBalance(
    provider: string,
    keyId: string,
    refresh = false,
  ): Promise<ModelBalance> {
    const suffix = refresh ? '?refresh=1' : ''
    const body = await request<{ balance: ModelBalance }>(
      `/api/model-config/providers/${encodeURIComponent(provider)}/api-keys/${encodeURIComponent(keyId)}/balance${suffix}`,
    )
    return body.balance
  },

  async updateStatus(): Promise<UpdateStatus> {
    const body = await request<{ update: UpdateStatus }>('/api/update')
    return body.update
  },

  async checkUpdate(): Promise<UpdateCheckResult> {
    const body = await request<{ check: UpdateCheckResult }>('/api/update/check', {
      method: 'POST',
    })
    return body.check
  },

  async startUpdateDownload(): Promise<UpdateJob> {
    const body = await request<{ job: UpdateJob }>('/api/update/download', { method: 'POST' })
    return body.job
  },

  async updateJob(): Promise<UpdateJob> {
    const body = await request<{ job: UpdateJob }>('/api/update/job')
    return body.job
  },

  async applyUpdate(): Promise<PendingUpdate> {
    const body = await request<{ pending: PendingUpdate }>('/api/update/apply', { method: 'POST' })
    return body.pending
  },

  async rollbackUpdate(): Promise<PendingUpdate> {
    const body = await request<{ pending: PendingUpdate }>('/api/update/rollback', { method: 'POST' })
    return body.pending
  },

  async saveUpdateConfig(manifestUrl: string): Promise<UpdateStatus> {
    const body = await request<{ update: UpdateStatus }>('/api/update/config', {
      method: 'POST',
      body: JSON.stringify({ manifestUrl }),
    })
    return body.update
  },

  async uploadUpdatePackage(file: File): Promise<{ version: string; program: string }> {
    const token = getToken()
    const response = await fetch('/api/update/package', {
      method: 'PUT',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/zip',
      },
      body: file,
    })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json() as { error?: string }
        if (body.error) detail = body.error
      } catch {
        // 非 JSON 错误
      }
      throw new ApiError(detail, response.status)
    }
    const body = await response.json() as { staged: { version: string; program: string } }
    return body.staged
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

  async mainAgentIdentityBackups(agentId: string): Promise<MainAgentIdentityBackup[]> {
    const body = await request<{ backups: MainAgentIdentityBackup[] }>(
      `/api/main-agents/${encodeURIComponent(agentId)}/identity/backups`,
    )
    return body.backups
  },

  async restoreMainAgentIdentity(
    agentId: string,
    file: string,
  ): Promise<{ slot: string; path: string; backup: string }> {
    const body = await request<{ result: { slot: string; path: string; backup: string } }>(
      `/api/main-agents/${encodeURIComponent(agentId)}/identity/backups/restore`,
      { method: 'POST', body: JSON.stringify({ file }) },
    )
    return body.result
  },

  async memoryPolicy(sessionId?: string, agentId?: string): Promise<ResolvedMemoryPolicy> {
    const params = new URLSearchParams()
    if (sessionId) params.set('sessionId', sessionId)
    if (agentId) params.set('agentId', agentId)
    const query = params.toString()
    const body = await request<{ policy: ResolvedMemoryPolicy }>(
      `/api/memory/policy${query ? `?${query}` : ''}`,
    )
    return body.policy
  },

  async setMemoryPolicy(
    scope: 'default' | 'agent' | 'session',
    id: string | undefined,
    policy: unknown,
  ): Promise<ResolvedMemoryPolicy> {
    const body = await request<{ policy: ResolvedMemoryPolicy }>('/api/memory/policy', {
      method: 'POST',
      body: JSON.stringify({ scope, ...(id ? { id } : {}), policy }),
    })
    return body.policy
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

  async memoryLibraryTree(): Promise<MemoryLibraryNode[]> {
    const body = await request<{ tree: MemoryLibraryNode[] }>('/api/memory/library/tree')
    return body.tree
  },

  async memoryLibraryRead(path: string): Promise<MemoryLibraryFile> {
    const params = new URLSearchParams({ path })
    const body = await request<{ file: MemoryLibraryFile }>(
      `/api/memory/library/file?${params.toString()}`,
    )
    return body.file
  },

  async writeMemoryLibrary(path: string, text: string): Promise<MemoryLibraryFile> {
    const body = await request<{ file: MemoryLibraryFile }>('/api/memory/library/file', {
      method: 'PUT',
      body: JSON.stringify({ path, text }),
    })
    return body.file
  },

  async mkdirMemoryLibrary(path: string): Promise<void> {
    await request('/api/memory/library/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
  },

  async moveMemoryLibrary(from: string, to: string): Promise<void> {
    await request('/api/memory/library/move', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    })
  },

  async removeMemoryLibrary(path: string, permanent = false): Promise<void> {
    await request('/api/memory/library/delete', {
      method: 'POST',
      body: JSON.stringify({ path, permanent }),
    })
  },

  async memoryLibraryTrash(): Promise<MemoryTrashEntry[]> {
    const body = await request<{ entries: MemoryTrashEntry[] }>('/api/memory/library/trash')
    return body.entries
  },

  async restoreMemoryLibrary(id: string, to?: string): Promise<void> {
    await request('/api/memory/library/restore', {
      method: 'POST',
      body: JSON.stringify({ id, ...(to ? { to } : {}) }),
    })
  },

  async memoryCommitStatus(): Promise<MemoryCommitStatus> {
    return request<MemoryCommitStatus>('/api/memory/commit')
  },

  async commitMemory(): Promise<MemoryCommitStatus> {
    return request<MemoryCommitStatus>('/api/memory/commit', {
      method: 'POST',
      body: '{}',
    })
  },

  async rebuildMemorySummaries(): Promise<{ queued: number; status: MemorySummaryWorkerStatus }> {
    return request('/api/memory/summaries/rebuild', {
      method: 'POST',
      body: '{}',
    })
  },

  async memorySummaryStatus(): Promise<MemorySummaryWorkerStatus> {
    return request<MemorySummaryWorkerStatus>('/api/memory/summaries/status')
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

  async setSessionMeta(
    sessionId: string,
    input: {
      category?: string | null
      pinned?: boolean
      thinkingHead?: string | null
      thinkingHeadEnabled?: boolean
    },
  ): Promise<SessionMeta> {
    const body = await request<{ meta: SessionMeta }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/meta`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    return body.meta
  },

  async usageStats(): Promise<UsageLedgerStats> {
    const body = await request<{ usage: UsageLedgerStats }>('/api/usage')
    return body.usage
  },

  async usageOverview(
    params: UsageQueryParams = {},
    timeZone: UsageTimeZone = 'local',
  ): Promise<UsageOverview> {
    const body = await request<{ overview: UsageOverview }>(
      `/api/usage/overview${usageQuery(params, { timeZone })}`,
    )
    return body.overview
  },

  async usageTimeline(
    params: UsageQueryParams = {},
    options: { bucket?: UsageBucket; timeZone?: UsageTimeZone } = {},
  ): Promise<UsageTimelinePoint[]> {
    const body = await request<{ points: UsageTimelinePoint[] }>(
      `/api/usage/timeline${usageQuery(params, {
        bucket: options.bucket,
        timeZone: options.timeZone ?? 'local',
      })}`,
    )
    return body.points
  },

  async usageGroups(
    params: UsageQueryParams = {},
    groupBy: UsageGroupBy = 'model',
    limit?: number,
  ): Promise<UsageGroupRow[]> {
    const body = await request<{ rows: UsageGroupRow[] }>(
      `/api/usage/groups${usageQuery(params, { groupBy, limit })}`,
    )
    return body.rows
  },

  async usageRequests(
    params: UsageQueryParams = {},
    options: { limit?: number; offset?: number } = {},
  ): Promise<UsageRequestPage> {
    const body = await request<{ page: UsageRequestPage }>(
      `/api/usage/requests${usageQuery(params, {
        limit: options.limit,
        offset: options.offset,
      })}`,
    )
    return body.page
  },
}
