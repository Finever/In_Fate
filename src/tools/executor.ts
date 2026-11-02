/**
 * 工具执行管线：pre → guard → 审批 → around → run → post → result。
 *
 * 任何一段都可以注册监听器，工具本体不感知审计、限流、脱敏。
 * 错误一律归一成 isError 的结果，不把异常漏给上层。
 *
 * @module if/tools/executor
 */

import type { Metrics } from '../core/metrics.ts'
import type {
  WorkspaceLeaseHandle,
  WorkspaceLeaseManager,
} from '../core/workspace-lease.ts'
import { resolve } from 'node:path'
import { validateValue } from './schema.ts'
import type { ToolRegistry } from './registry.ts'
import type {
  ApprovalRegistry,
  DispatchDecision,
  NetworkGuard,
  PathSandbox,
  ToolContext,
  ToolResult,
} from './types.ts'

export interface PipelineHooks {
  pre?: (name: string, args: unknown, context: ToolContext) => unknown | { readonly cancel: true } | void
  guard?: (name: string, args: unknown, context: ToolContext) => 'allow' | 'ask' | 'deny' | void
  around?: (name: string, run: () => Promise<ToolResult>, context: ToolContext) => Promise<ToolResult>
  post?: (name: string, result: ToolResult, context: ToolContext) => ToolResult | void
  result?: (name: string, result: ToolResult, context: ToolContext) => void
}

export interface ExecuteOptions {
  readonly registry: ToolRegistry
  readonly approvals: ApprovalRegistry
  readonly callId: string
  readonly sessionId: string
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** 审批无人应答时的超时，默认 60 秒后按拒绝处理 */
  readonly approvalTimeoutMs?: number
  readonly sandbox?: PathSandbox
  readonly network?: NetworkGuard
  readonly leases?: WorkspaceLeaseManager
  readonly workspaceId?: string
  readonly metrics?: Metrics
  /** 按 agent 收窄可执行工具；不传=注册表启用状态。 */
  readonly allowedTools?: ReadonlySet<string>
  /** 按 agent 覆盖审批模式；优先级低于 hooks.guard。 */
  readonly approvalOverrides?: Readonly<Record<string, 'auto' | 'required'>>
  readonly hooks?: PipelineHooks
}

function errorResult(text: string): ToolResult {
  return { text, isError: true }
}

function isCancel(value: unknown): value is { readonly cancel: true } {
  return typeof value === 'object' && value !== null && 'cancel' in value
}

function timeoutFromArgs(args: unknown): number | undefined {
  if (typeof args !== 'object' || args === null || !('timeoutMs' in args)) return undefined
  const value = (args as { timeoutMs?: unknown }).timeoutMs
  return typeof value === 'number' && value > 0 ? value : undefined
}

function requestApproval(
  name: string,
  args: unknown,
  options: ExecuteOptions,
  context: ToolContext,
): Promise<DispatchDecision> {
  const approvalId = `${options.sessionId}:${options.callId}:${name}`
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      options.approvals.respond(approvalId, { approved: false, reason: 'approval timeout' })
    }, options.approvalTimeoutMs ?? 60_000)

    options.approvals.request({
      approvalId,
      sessionId: options.sessionId,
      toolCallId: options.callId,
      toolName: name,
      originalInput: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
      signal: context.signal,
      resolve: decision => {
        clearTimeout(timer)
        resolve(decision)
      },
    })
  })
}

async function executeToolInner(
  name: string,
  rawArgs: unknown,
  options: ExecuteOptions,
): Promise<ToolResult> {
  const tool = options.registry.get(name)
  if (!tool) return errorResult(`unknown tool: ${name}`)

  const descriptor = options.registry.list({ includeDisabled: true }).find(item => item.name === name)
  if (!descriptor?.enabled) return errorResult(`tool disabled: ${name}`)
  if (options.allowedTools && !options.allowedTools.has(name)) {
    return errorResult(`tool not allowed for this agent: ${name}`)
  }

  const issues = validateValue(tool.inputSchema, rawArgs)
  if (issues.length > 0) {
    return errorResult(`invalid arguments: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  }

  const controller = new AbortController()
  const external = options.signal
  const onAbort = (): void => controller.abort(external?.reason)
  external?.addEventListener('abort', onAbort, { once: true })

  const timeoutMs = options.timeoutMs ?? timeoutFromArgs(rawArgs) ?? options.registry.timeoutOf(name)
  const timer = setTimeout(() => controller.abort(new Error('tool timeout')), timeoutMs)

  const context: ToolContext = {
    sessionId: options.sessionId,
    callId: options.callId,
    cwd: options.cwd,
    signal: controller.signal,
    approvals: options.approvals,
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.network ? { network: options.network } : {}),
  }

  let lease: WorkspaceLeaseHandle | undefined
  let leaseRenew: NodeJS.Timeout | undefined

  try {
    let args = rawArgs

    // pre：补默认、归一、拒绝
    if (options.hooks?.pre) {
      const output = options.hooks.pre(name, args, context)
      if (isCancel(output)) return errorResult('cancelled by pre hook')
      if (output !== undefined) args = output
    }

    // guard：策略优先，其次 agent 覆盖，最后注册表的 approval
    const guard = options.hooks?.guard?.(name, args, context)
    const approval = options.approvalOverrides?.[name] ?? descriptor.approval
    const mode = guard ?? (approval === 'required' ? 'ask' : 'allow')
    if (mode === 'deny') return errorResult('denied by policy')
    if (mode === 'ask') {
      const decision = await requestApproval(name, args, options, context)
      if (!decision.approved) return errorResult(decision.reason ?? 'denied')
      if (decision.updatedInput) args = decision.updatedInput
    }

    // 写租约：审批之后才拿，避免用户看审批卡时把 workspace 堵住。
    const writeScope = tool.meta?.writeScope
    if (writeScope && options.leases) {
      let target: string | undefined
      if (writeScope === 'path') {
        const raw = typeof args === 'object' && args !== null
          ? (args as { file_path?: unknown }).file_path
          : undefined
        if (typeof raw !== 'string' || raw.length === 0) {
          return errorResult('path lease needs file_path')
        }
        target = options.sandbox
          ? options.sandbox.resolveWrite(raw, options.cwd)
          : resolve(options.cwd, raw)
      }
      const started = Date.now()
      try {
        lease = await options.leases.acquire({
          workspaceId: options.workspaceId ?? options.cwd,
          scope: writeScope,
          ...(target ? { target } : {}),
          sessionId: options.sessionId,
          toolCallId: options.callId,
          signal: context.signal,
        })
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
      options.metrics?.observe('workspace.lease_wait_ms', Date.now() - started, {
        scope: writeScope,
      })
      leaseRenew = setInterval(() => lease?.renew(), options.leases.renewMs)
      leaseRenew.unref?.()
    }

    const run = async (): Promise<ToolResult> => tool.run(args, context)
    let result = options.hooks?.around
      ? await options.hooks.around(name, run, context)
      : await run()

    // post：改写、脱敏、裁剪
    if (options.hooks?.post) {
      result = options.hooks.post(name, result, context) ?? result
    }

    if (tool.finalizeContent) result = tool.finalizeContent(result)
    if (tool.presentResult) {
      result = { ...result, presentation: tool.presentResult(args, result) }
    }

    options.hooks?.result?.(name, result, context)
    return result
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  } finally {
    if (leaseRenew) clearInterval(leaseRenew)
    lease?.release()
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
  options: ExecuteOptions,
): Promise<ToolResult> {
  const started = Date.now()
  options.metrics?.inc('tool.calls', 1, { tool: name })
  let result: ToolResult

  try {
    result = await executeToolInner(name, rawArgs, options)
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error))
  }

  options.metrics?.observe('tool.duration_ms', Date.now() - started, { tool: name })
  if (result.isError) options.metrics?.inc('tool.errors', 1, { tool: name })
  return result
}
