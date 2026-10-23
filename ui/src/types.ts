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

export interface UiTimelinePage {
  sessionId: string
  items: UiTimelineItem[]
  turns: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  nextBefore?: number
  nextAfter?: number
  asOfSeq?: number
  generation?: number
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

export interface UiApproval {
  approvalId: string
  sessionId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
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

export interface SessionInfo {
  id: string
  file: string
  bytes: number
  updatedAt: string
}

export interface AgentRunInfo {
  id: string
  preset: string
  status: string
  summary: string
  updatedAt: string
}

export interface TurnResponse {
  turn: number
  items: UiTimelineItem[]
}
