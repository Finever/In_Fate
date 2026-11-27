import type { Profile } from '../config/profile.ts'
import type { HistoryMessage } from '../projections/history.ts'

export type ContextLayer = 'stable' | 'dynamic' | 'ephemeral'

export interface PipelineContext {
  readonly profile: Profile
  readonly sessionId: string
  readonly turn: number
  /** 由调用方注入，管线内部不读当前时间（纯函数） */
  readonly now: Date
  readonly history: readonly HistoryMessage[]
}

export interface SectionOutput {
  readonly text?: string
  readonly messages?: readonly HistoryMessage[]
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface ContextSection {
  readonly id: string
  readonly layer: ContextLayer
  readonly priority: number
  render(context: PipelineContext): SectionOutput | void
}
