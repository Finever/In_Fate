export type SessionLifecycle = 'active' | 'archived' | 'deleted'
export type SessionState = 'idle' | 'running' | 'waiting' | 'done' | 'unknown'

export interface SessionCreatedFrom {
  sessionId: string
  eventId?: string
}

export interface SessionInfo {
  id: string
  file: string
  bytes: number
  updatedAt: string
  createdBy?: string
  createdFrom?: SessionCreatedFrom
  agentId?: string
  reason?: string
  kind?: 'user' | 'agent'
  lifecycle: SessionLifecycle
  state?: SessionState
  lastActivity?: string
  title?: string
  /** 用户自定义分类；空表示未分类 */
  category?: string
  pinned?: boolean
  thinkingHead?: string
  thinkingHeadEnabled?: boolean
}

export interface SessionMeta {
  sessionId: string
  category?: string
  pinned?: boolean
  thinkingHead?: string
  thinkingHeadEnabled?: boolean
  updatedAt: string
  updatedBy: string
}

export interface AgentRunInfo {
  id: string
  preset: string
  status: string
  summary: string
  updatedAt: string
  lifecycle: SessionLifecycle
}

export interface MainAgentSlot {
  id: string
  label: string
  file: string
  order: number
  description?: string
  role?: string
  layer?: string
  priority?: number
}

export interface MainAgentInfo {
  version: 1
  id: string
  name: string
  identity: MainAgentSlot[]
}

export interface MainAgentSlotContent extends MainAgentSlot {
  path: string
  content: string
}

export interface MainAgentIdentity {
  manifest: MainAgentInfo
  slots: MainAgentSlotContent[]
}

export interface MainAgentIdentityBackup {
  file: string
  slot: string
  bytes: number
  updatedAt: string
}

export interface MemoryQuote {
  say: string
  at?: string | null
  tag?: string[]
  'log-addr'?: string
}

export interface MemoryEntry {
  id: string
  'rec-time': string
  'rev-time': string | null
  at: string | null
  tag: '确信' | '可信' | '有疑'
  content: string
  quotes?: MemoryQuote[]
}

export interface MemoryDocument {
  project: string
  filename: string
  introduction: string
  entries: MemoryEntry[]
}

export interface MemorySearchHit {
  target: string
  id: string
  tag: '确信' | '可信' | '有疑'
  preview: string
  filename: string
}

export interface MemoryFileSummary {
  domain: string
  namespace?: string
  project: string
  filename: string
  target: string
  introduction: string
  entries: number
  quotes: number
  bytes: number
  updatedAt: string
  private?: boolean
  invalid?: string
}

export type MemoryLibraryArea = 'detail' | 'summaries' | 'proposals' | 'agents' | 'root'

export interface MemoryLibraryNode {
  path: string
  name: string
  kind: 'directory' | 'file'
  area: MemoryLibraryArea
  readOnly: boolean
  target?: string
  private?: boolean
  invalid?: string
  entries?: number
  bytes?: number
  updatedAt?: string
}

export interface MemoryLibraryFile {
  path: string
  area: MemoryLibraryArea
  readOnly: boolean
  text: string
  bytes: number
  updatedAt: string
  json?: unknown
  document?: MemoryDocument
  invalid?: string
}

export interface MemoryTrashEntry {
  id: string
  original: string
  name: string
  kind: 'directory' | 'file'
  movedAt: string
}

export interface MemoryCommitStatus {
  gitRoot?: string
  enabled: boolean
  dirty: string[]
}

export interface MemoryValidationIssue {
  level: 'error' | 'warning'
  path: string
  message: string
}

export interface MemoryIndexItem {
  path: string
  what: string
  n?: number
  updated?: string
}

export interface MemoryIndexList {
  kind: 'indexlist'
  generated: string
  root: string
  items: MemoryIndexItem[]
}

export interface LogTreeFile {
  sid: string
  size: number
  mtime: number
}

export interface LogTreeDay {
  day: string
  files: LogTreeFile[]
}

export interface LogTree {
  days: LogTreeDay[]
}

export interface LogViewRow {
  n?: number
  who: string
  kind: 'msg' | 'tool'
  ts: string
  body: string
}

export interface LogViewPage {
  total: number
  offset: number
  rows: LogViewRow[]
  focus: number | null
  meta?: Record<string, string>
}

export interface LogSearchHit {
  day: string
  sid: string
  n?: number
  who: string
  ts: string
  text: string
  trunc: boolean
  addr: string
}

export interface LogSearchResult {
  hits: LogSearchHit[]
  total: number
}

export interface ModelRef {
  provider: string
  model: string
}

export interface PriceRate {
  currency: string
  perMillionTokens: number
}

export interface PricingWindow {
  days?: number[]
  start: string
  end: string
}

export interface ModelPricing {
  input?: PriceRate
  output?: PriceRate
  cacheRead?: PriceRate
  cacheWrite?: PriceRate
  offPeak?: {
    input?: PriceRate
    output?: PriceRate
    cacheRead?: PriceRate
    cacheWrite?: PriceRate
    windows: PricingWindow[]
  }
}

export interface ModelApiKeyView {
  id: string
  name?: string
  preview: string
  isEnabled: boolean
  legacy?: boolean
}

export interface ModelConfigProvider {
  id: string
  name: string
  endpointFamily: string
  endpointFamilies: string[]
  endpoints: Array<{ family: string; baseUrl: string }>
  baseUrl: string
  models: Array<{
    id: string
    name?: string
    contextWindow?: number
    maxOutputTokens?: number
    pricing?: ModelPricing
    enabled: boolean
  }>
  apiKeys: ModelApiKeyView[]
  hasApiKey: boolean
  /** 上游是否提供可直接用 key 查询的余额接口。 */
  balanceSupported: boolean
  apiKeyEnv?: string
  enabled: boolean
  removable: boolean
}

export interface BalanceAmount {
  currency: string
  total: number
  available: number
  granted?: number
  toppedUp?: number
  totalUsage?: number
}

export interface ModelBalance {
  provider: string
  keyId: string
  checkedAt: string
  source: 'api'
  balances: BalanceAmount[]
}

export type UpdateLayout = 'dev' | 'portable' | 'installed'
export type UpdateJobState = 'idle' | 'checking' | 'downloading' | 'staging' | 'ready' | 'error'

export interface UpdateJob {
  state: UpdateJobState
  version?: string
  downloaded: number
  total?: number
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface PendingUpdate {
  action: 'apply' | 'rollback'
  version: string
  fromVersion: string
  program?: string
  requestedAt: string
}

export interface UpdateManifest {
  version: string
  url: string
  sha256: string
  size?: number
  notes?: string
  publishedAt?: string
}

export interface UpdateCheckResult {
  currentVersion: string
  manifest: UpdateManifest
  resolvedUrl: string
  available: boolean
}

export interface UpdateStatus {
  currentVersion: string
  layout: UpdateLayout
  installRoot: string
  programRoot: string
  appDir: string
  dataRoot: string
  manifestUrl?: string
  pending?: PendingUpdate
  previousVersion?: string
  job: UpdateJob
}

export interface ModelConfig {
  timeZone: string
  providers: ModelConfigProvider[]
}

export interface SaveModelConfigInput {
  provider: string
  apiKey?: string
  baseUrl?: string
  format?: string
  enabled?: boolean
}

export interface SaveModelCardInput {
  provider: string
  model: string
  contextWindow?: number | null
  maxOutputTokens?: number | null
  pricing?: ModelPricing | null
  enabled?: boolean
}

export interface ModelProviderModelInput {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export interface ModelProviderInput {
  id: string
  name: string
  description?: string
  baseUrl: string
  apiKey?: string
  apiKeyName?: string
  apiKeyEnv?: string
  format?: string
  endpoints?: Record<string, { baseUrl: string }>
  models: ModelProviderModelInput[]
}

export interface ModelProviderTemplate {
  id: string
  name: string
  description?: string
  apiKeyEnv?: string
  defaultChatEndpoint?: string
  endpoints: Record<string, { baseUrl: string; adapterFamily?: string }>
  models: Array<{
    id: string
    name?: string
    contextWindow?: number
    maxOutputTokens?: number
  }>
}

export interface EmbeddingModelPreset {
  id: string
  name: string
  description: string
  repo: string
  file: string
  size: number
  sha256: string
  dimensions: number
  contextSize: number
  license: string
  quantization: string
  queryPrefix: string
}

export interface EmbeddingModelManifest {
  id: string
  repo: string
  file: string
  path: string
  size: number
  sha256: string
  dimensions: number
  contextSize: number
  license: string
  quantization: string
  installedAt: string
}

export interface EmbeddingModelStatus {
  preset: EmbeddingModelPreset
  installed: boolean
  active: boolean
  manifest?: EmbeddingModelManifest
  totalBytes: number
}

export interface EmbeddingInstallJob {
  id: string
  modelId: string
  status: 'running' | 'done' | 'error'
  received: number
  total: number
  ratio: number
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface AgentPresetSummary {
  id: string
  description: string
}

export interface AgentSummary {
  id: string
  name: string
  hasManifest: boolean
  model?: ModelRef
  modelConfigured: boolean
  prefillSupported: boolean
  subagentModels: ModelRef[]
  subagentPresets?: string[]
  availablePresets: AgentPresetSummary[]
  tools: {
    allow?: string[]
    approval?: Record<string, 'auto' | 'required'>
  }
  sessionCount: number
  deletable: boolean
  deleteBlockedReason?: string
}

export interface AgentSettingsUpdate {
  model?: ModelRef
  subagentModels?: ModelRef[]
  subagentPresets?: string[]
  tools?: {
    allow?: string[]
    approval?: Record<string, 'auto' | 'required'>
  }
}

export interface ToolView {
  name: string
  description?: string
  source: string
  enabled: boolean
  approval: 'auto' | 'required'
  dangerous: boolean
  readOnly: boolean
  agentAllowed: boolean
  agentApproval?: 'auto' | 'required'
  effectiveApproval: 'auto' | 'required'
}

export interface MemoryProposal {
  kind: 'detail' | 'identity'
  proposalId: string
  target: string
  sourceSession: string
  reason?: string
  entry?: {
    content: string
    tag: '确信' | '可信' | '有疑'
    at?: string | null
  }
  identity?: {
    file: 'SOUL' | 'USER' | 'FACT'
    section: string
    content: string
    mode?: 'replace-section' | 'append'
  }
  status: 'pending' | 'applying' | 'accepted' | 'rejected'
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
}

export type LinkRelation = 'peer' | 'handoff' | 'reference'

export interface LinkSidePermissions {
  read: boolean
  message: boolean
}

export interface LinkPermissions {
  from: LinkSidePermissions
  to: LinkSidePermissions
}

export interface SessionLink {
  linkId: string
  from: string
  to: string
  relation: LinkRelation
  permissions: LinkPermissions
  snapshotSeq?: number
  createdBy: string
  createdAt: string
  reason?: string
  status: 'active' | 'closed'
  closedAt?: string
  closedBy?: string
  closeReason?: string
}

export interface SessionJoinSnapshot {
  joinId: string
  sessionId: string
  targets: string[]
  mode: 'all' | 'any'
  timeoutMs: number
  createdAt: string
  status: 'pending' | 'done' | 'timeout' | 'cancelled'
  satisfied: string[]
}

export interface PendingToolCall {
  callId: string
  name: string
}

export interface SessionInspection {
  sessionId: string
  createdBy?: string
  createdFrom?: SessionCreatedFrom
  agentId?: string
  reason?: string
  kind?: 'user' | 'agent'
  lifecycle: SessionLifecycle
  state: SessionState
  events: number
  lastSeq: number
  lastType?: string
  lastTs?: string
  lastTurnSeq?: number
  pendingToolCalls: PendingToolCall[]
  links?: SessionLink[]
  joins?: SessionJoinSnapshot[]
}

export interface SessionLifecycleRecord {
  sessionId: string
  state: SessionLifecycle
  updatedAt: string
  updatedBy: string
  reason?: string
}

export interface UiApproval {
  approvalId: string
  sessionId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  reason?: string
}

export interface UiContent {
  preview: string
  bytes: number
  mime?: string
  encoding?: string
  ref?: string
  truncated: boolean
}

export interface UiToolCard {
  callId: string
  name: string
  argsPreview: string
  argsBytes: number
  result?: UiContent
  resultEventId?: string
  isError: boolean
  status: 'running' | 'ok' | 'error'
  durationMs?: number
}

export type UiItemKind =
  | 'user'
  | 'assistant'
  | 'system'
  | 'thoughts'
  | 'tool'
  | 'compaction'
  | 'turn'

export interface TurnCost {
  currency: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  priced: boolean
  period: 'standard' | 'peak' | 'offPeak' | 'mixed'
}

export interface UiTimelineItem {
  id: string
  seq: number
  turn: number
  kind: UiItemKind
  ts: string
  actor?: string
  status?: 'running' | 'ok' | 'error' | 'cancelled' | 'waiting'
  title: string
  content?: UiContent
  tool?: UiToolCard
  compaction?: { summary: unknown; anchor: unknown; stats: unknown }
  turnUsage?: {
    steps: number
    usage: { input: number; output: number; cacheRead: number }
    hitLimit: boolean
    model?: { provider: string; model: string }
    durationMs?: number
    modelDurationMs?: number
    toolDurationMs?: number
    cost?: TurnCost
  }
}

export interface UiTurnMeta {
  turn: number
  startSeq: number
  endSeq: number
  itemCount: number
}

export interface UiSessionStats {
  sessionId: string
  events: number
  turns: number
  compacted: number
  pruned: number
  lastSeq: number
  asOfSeq?: number
  fileBytes: number
  segments: number
}

export interface UiPayloadSlice {
  data: string
  offset: number
  totalChars: number
  eof: boolean
  bytes: number
  mime?: string
  encoding?: string
}

export interface TurnResponse {
  turn: number
  items: UiTimelineItem[]
}

export type MemoryMode = 'off' | 'rag-tool' | 'jev-push'
export type MemoryPolicyScope = 'session' | 'agent' | 'domain' | 'target' | 'all'

export interface ResolvedMemoryPolicy {
  mode: MemoryMode
  scope: MemoryPolicyScope
  scopeValue?: string
  write: { approval: 'required' | 'off' }
  jev: {
    enabled: 'off' | 'once' | 'always'
    backend: 'local' | 'api'
    scope: MemoryPolicyScope
    scopeValue?: string
    reanalyzeOnCompaction: boolean
  }
  rag: { topK: number }
  maxEntries: number
  maxBytes: number
}

export type MemorySummaryJobStatus = 'queued' | 'running' | 'done' | 'skipped' | 'error' | 'unavailable'

export interface MemorySummaryJob {
  target: string
  status: MemorySummaryJobStatus
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface MemorySummaryWorkerStatus {
  generator: boolean
  running: boolean
  queued: number
  jobs: MemorySummaryJob[]
  lastError?: string
}

export type PluginKind = 'tool' | 'ui-panel'
export type PluginCapability = 'tools.register' | 'ui.panel' | 'storage'
export type PluginTrust = 'builtin' | 'dev'
export type PluginStatus = 'inactive' | 'activating' | 'active' | 'disabled' | 'error'

export interface PluginPanelInfo {
  id: string
  title: string
  slot?: 'settings'
  width?: number
  height?: number
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  apiVersion: number
  description?: string
  trust: PluginTrust
  status: PluginStatus
  provides: PluginKind[]
  capabilities: PluginCapability[]
  tools: string[]
  panels: PluginPanelInfo[]
  error?: string
}

export interface PluginLoadError {
  path: string
  error: string
}

export interface PluginListResult {
  plugins: PluginInfo[]
  errors: PluginLoadError[]
}

export interface PluginPanelContent extends PluginPanelInfo {
  pluginId: string
  html: string
}
