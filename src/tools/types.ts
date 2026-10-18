/**
 * 工具契约：执行、结果、策略、审批。
 *
 * 结果永远是 envelope，不是 string；审批是驱动无关的中性决策；
 * 工具来源与启停属于注册表，不属于工具本体。
 *
 * @module if/tools/types
 */

import type { ToolSpec } from '../model/types.ts'

export type ToolSource = 'builtin' | 'plugin' | 'mcp' | 'client'
export type ApprovalMode = 'auto' | 'required'

/** 结果 envelope。编码、字节、mime 都是一等字段。 */
export interface ToolResult {
  readonly text?: string
  readonly structured?: unknown
  readonly bytes?: number
  readonly encoding?: string
  readonly mime?: string
  /** 大输出溢出到 spill 后留下的引用 */
  readonly ref?: string
  readonly isError?: boolean
  /** presentResult 的产物，给 UI；模型看不到 */
  readonly presentation?: unknown
}

export interface ToolContext {
  readonly sessionId: string
  readonly callId: string
  readonly cwd: string
  readonly signal: AbortSignal
  readonly approvals?: ApprovalRegistry
  readonly profile?: unknown
}

export interface ToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
  readonly output?: { readonly schema?: unknown; readonly mime?: string }
  readonly meta?: {
    readonly readOnly?: boolean
    readonly dangerous?: boolean
    readonly timeoutMs?: number
  }
  run(args: unknown, context: ToolContext): Promise<ToolResult>
  /** 纯函数：待执行卡片的展示投影 */
  presentCall?(args: unknown): unknown
  /** 纯函数：完成卡片的展示投影 */
  presentResult?(args: unknown, result: ToolResult): unknown
  /** 结果最终化：裁切、脱敏、溢出 */
  finalizeContent?(result: ToolResult): ToolResult
}

export interface ToolDescriptor {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
  readonly source: ToolSource
  readonly enabled: boolean
  readonly approval: ApprovalMode
  readonly revision: number
}

export interface ToolPatch {
  readonly description?: string
  readonly inputSchema?: unknown
  readonly enabled?: boolean
  readonly approval?: ApprovalMode
  readonly timeoutMs?: number
}

export type ToolChange =
  | { readonly type: 'added'; readonly name: string; readonly descriptor: ToolDescriptor }
  | { readonly type: 'removed'; readonly name: string; readonly descriptor: ToolDescriptor }
  | { readonly type: 'updated'; readonly name: string; readonly descriptor: ToolDescriptor }
  | { readonly type: 'enabled'; readonly name: string; readonly descriptor: ToolDescriptor }
  | { readonly type: 'disabled'; readonly name: string; readonly descriptor: ToolDescriptor }

export interface ToolPolicyEntry {
  readonly name: string
  readonly source: ToolSource
  readonly approval: ApprovalMode
  readonly bypass: 'lift' | 'enforce'
}

export interface DispatchDecision {
  readonly approved: boolean
  readonly reason?: string
  readonly reasonSource?: 'user'
  /** 批准时允许改参数（Cherry 的做法） */
  readonly updatedInput?: Record<string, unknown>
}

export interface PendingApproval {
  readonly approvalId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly originalInput: Record<string, unknown>
  readonly presentation?: 'stream' | 'message'
  readonly signal?: AbortSignal
  readonly resolve: (decision: DispatchDecision) => void
}

export interface ApprovalRegistry {
  /** true = 已挂起等待；false = 同步拒绝（重复 id 或已取消） */
  request(entry: PendingApproval): boolean
  respond(approvalId: string, decision: DispatchDecision): boolean
  pending(): readonly PendingApproval[]
  cancelBySession(sessionId: string): void
}

/** 注册表给模型看的 spec：只含有权限、已启用的。 */
export function toModelSpec(descriptor: ToolDescriptor): ToolSpec {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  }
}
