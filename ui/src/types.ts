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
  project: string
  filename: string
  target: string
  introduction: string
  entries: number
  quotes: number
  bytes: number
  updatedAt: string
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

export interface ModelConfigProvider {
  id: string
  name: string
  endpointFamily: string
  baseUrl: string
  models: Array<{
    id: string
    name?: string
    contextWindow?: number
    maxOutputTokens?: number
    pricing?: ModelPricing
  }>
  hasApiKey: boolean
  apiKeyEnv?: string
}

export interface ModelConfig {
  timeZone: string
  providers: ModelConfigProvider[]
}

export interface SaveModelConfigInput {
  provider: string
  apiKey?: string
  baseUrl?: string
}

export interface SaveModelCardInput {
  provider: string
  model: string
  contextWindow?: number | null
  maxOutputTokens?: number | null
  pricing?: ModelPricing | null
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
  subagentModels: ModelRef[]
  subagentPresets?: string[]
  availablePresets: AgentPresetSummary[]
  tools: {
    allow?: string[]
    approval?: Record<string, 'auto' | 'required'>
  }
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
