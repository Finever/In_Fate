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
  reason?: string
  kind?: 'user' | 'agent'
  lifecycle: SessionLifecycle
  state?: SessionState
  lastActivity?: string
}

export interface AgentRunInfo {
  id: string
  preset: string
  status: string
  summary: string
  updatedAt: string
  lifecycle: SessionLifecycle
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

export interface UiTimelineItem {
  id: string
  seq: number
  turn: number
  kind: UiItemKind
  ts: string
  actor?: string
  status?: 'running' | 'ok' | 'error' | 'cancelled'
  title: string
  content?: UiContent
  tool?: UiToolCard
  compaction?: { summary: unknown; anchor: unknown; stats: unknown }
  turnUsage?: {
    steps: number
    usage: { input: number; output: number; cacheRead: number }
    hitLimit: boolean
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
