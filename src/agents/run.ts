/**
 * 子 agent 执行：预设模型候选链 → 上下文 → 模型 → 工具 → 回填。
 *
 * fresh 模式：不继承父对话，只拿请求里的 prompt/context/acceptance。
 * 工具白名单由调用方在建 Registry 时过滤；这里不注册派活工具。
 *
 * @module if/agents/run
 */

import type { Profile } from '../config/profile.ts'
import { renderContext } from '../context/pipeline.ts'
import { staticSection, timeSection } from '../context/sections.ts'
import { TokenEstimator } from '../compaction/estimate.ts'
import type { Event, NewEvent } from '../core/events.ts'
import type { Metrics } from '../core/metrics.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import type { EventStore } from '../core/store.ts'
import type { WorkspaceLeaseManager } from '../core/workspace-lease.ts'
import { agentStream } from '../core/streams.ts'
import { chatModel } from '../model/chat-model.ts'
import type { ModelGate } from '../model/gate.ts'
import { resolveModel, type ModelRegistry, type ResolvedModel } from '../model/registry.ts'
import type { ModelRetryPolicy } from '../model/retry.ts'
import type { ModelEvent, ToolSpec } from '../model/types.ts'
import { projectHistory } from '../projections/history.ts'
import { executeTool } from '../tools/executor.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type {
  ApprovalRegistry,
  NetworkGuard,
  PathSandbox,
  ToolResult,
} from '../tools/types.ts'
import { addCost, costOfUsage, type CostBreakdown } from '../model/pricing.ts'
import type { OffloadPolicy } from '../tools/offload.ts'
import { recordToolResultOnce } from '../tools/persist.ts'
import { trimHistoryForContext } from './context.ts'
import type { AgentPreset, AgentRequest, AgentResult, AgentUsage } from './types.ts'

export interface SubagentRuntime {
  readonly tools: ToolRegistry
  readonly approvals: ApprovalRegistry
  readonly profile: Profile
  readonly cwd: string
  /** 子 agent 自己的会话写者；不传则直接写 store */
  readonly writer?: SessionWriter
  /** 工具结果写时卸载 */
  readonly offload?: OffloadPolicy
  /** 与主 agent 共享的校准估算器；不传就新建 */
  readonly estimator?: TokenEstimator
  /** 传了就用实例注册表；不传退回模块级默认实例（旧 demo 兼容） */
  readonly models?: ModelRegistry
  /** 带 provider/model 覆盖的解析器；优先于 models。 */
  readonly resolveModel?: (provider: string, model: string) => ResolvedModel
  readonly modelRetry?: ModelRetryPolicy
  readonly sandbox?: PathSandbox
  readonly network?: NetworkGuard
  readonly leases?: WorkspaceLeaseManager
  readonly workspaceId?: string
  readonly modelGate?: ModelGate
  readonly metrics?: Metrics
}

interface Collected {
  readonly text: string
  readonly reasoning: string
  readonly calls: readonly { id: string; name: string; arguments: string }[]
  readonly usage: AgentUsage
}

async function collectModel(
  model: ResolvedModel,
  system: string,
  messages: Parameters<typeof chatModel>[0]['messages'],
  tools: readonly ToolSpec[],
  signal: AbortSignal,
  retry?: ModelRetryPolicy,
  metrics?: Metrics,
  gate?: ModelGate,
  priority: 'interactive' | 'normal' | 'background' = 'normal',
): Promise<Collected> {
  const text: string[] = []
  const reasoning: string[] = []
  const calls: { id: string; name: string; arguments: string }[] = []
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0 }

  for await (const event of chatModel({
    resolved: model,
    system,
    messages,
    tools,
    signal,
    ...(retry ? { retry } : {}),
    ...(gate ? { gate } : {}),
    priority,
    onAttempt: () => metrics?.inc('model.attempts', 1, { source: 'agent' }),
    onRetry: info => {
      metrics?.inc('model.retries', 1, { source: 'agent' })
      metrics?.observe('model.retry_delay_ms', info.delayMs, { source: 'agent' })
    },
  })) {
    if (event.type === 'text') text.push(event.text)
    else if (event.type === 'reasoning') reasoning.push(event.text)
    else if (event.type === 'tool_call') calls.push(event)
    else if (event.type === 'usage') {
      usage.input += event.input ?? 0
      usage.output += event.output ?? 0
      usage.cacheRead += event.cacheRead ?? 0
    }
  }

  return { text: text.join(''), reasoning: reasoning.join(''), calls, usage }
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function buildPrompt(request: AgentRequest): string {
  const parts = [`任务：${request.prompt}`]
  if (request.context) parts.push(`背景：${request.context}`)
  if (request.acceptance && request.acceptance.length > 0) {
    parts.push(`验收：\n${request.acceptance.map(item => `- ${item}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * 子 agent 实际可用的工具名。
 *
 * 硬约束不依赖 guard：只读预设永远没有写工具；非只读预设的危险工具
 * 只有 allowDangerousTools === true 才可见；子 agent 不再派活。
 */
export function allowedToolNames(preset: AgentPreset, tools: ToolRegistry): string[] {
  const writeTools = new Set(['write', 'edit', 'bash'])
  return preset.tools.filter(name => {
    if (
      name === 'request_agent'
      || name === 'model_list'
      || name === 'session_join'
      || name === 'session_create'
      || name === 'session_message'
      || name.startsWith('agent_')
    ) return false
    if (preset.readOnly && writeTools.has(name)) return false
    const dangerous = Boolean(tools.get(name)?.meta?.dangerous)
    if (dangerous && preset.allowDangerousTools !== true) return false
    return true
  })
}

export async function runSubagent(
  request: AgentRequest,
  signal: AbortSignal,
  store: EventStore,
  stream: string,
  runtime: SubagentRuntime,
): Promise<AgentResult> {
  const preset = request.snapshot
  const allowed = new Set(allowedToolNames(preset, runtime.tools))
  const estimator = runtime.estimator ?? new TokenEstimator()
  const append = (input: NewEvent): Event =>
    runtime.writer ? runtime.writer.append(input) : store.append(input)
  const flush = (): void => {
    if (runtime.writer) runtime.writer.flush()
    else store.flush()
  }

  const resolve = runtime.resolveModel
    ?? (runtime.models
      ? (provider: string, model: string): ResolvedModel => runtime.models!.resolve(provider, model)
      : resolveModel)

  const startedAt = new Date().toISOString()
  const runStartedMs = Date.now()
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0 }
  let cost: CostBreakdown = {
    currency: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    priced: false,
    period: 'standard',
  }
  let modelDurationMs = 0
  let usedModel: { provider: string; model: string } | undefined
  const artifacts = new Set<string>()
  let steps = 0
  let lastText = ''
  let status: AgentResult['status'] = 'completed'
  let errorText: string | undefined

  append({
    stream,
    actor: 'user',
    type: 'message.user',
    payload: { text: buildPrompt(request) },
  })

  while (steps < preset.maxSteps) {
    if (signal.aborted) {
      status = 'cancelled'
      errorText = 'aborted'
      break
    }
    flush()

    const history = projectHistory(store.read())
    const rendered = renderContext({
      sections: [
        staticSection(
          'header',
          preset.systemPrompt
            ?? '你是子 agent。只按请求完成任务，不闲聊；不满足验收就明确说没完成。',
        ),
        timeSection(),
      ],
      history,
      profile: runtime.profile,
      sessionId: request.id,
      turn: steps + 1,
      now: new Date(),
    })

    const tools = runtime.tools.toModelSpecs({ allowed })
    let messages = rendered.messages
    if (preset.budget?.maxContextTokens) {
      const trimmed = trimHistoryForContext(
        messages,
        rendered.system,
        tools,
        preset.budget.maxContextTokens,
        estimator,
      )
      messages = trimmed.messages
      if (trimmed.over) {
        status = 'failed'
        errorText = `context_budget_exceeded: ${trimmed.estimated} > ${preset.budget.maxContextTokens}`
        break
      }
    }

    let collected: Collected | undefined
    let lastError: unknown

    // 模型候选链：只在本步没有执行任何工具前降级，避免副作用重放。
    for (const choice of preset.models) {
      if (signal.aborted) break
      const modelStarted = Date.now()
      const pricedAt = new Date()
      try {
        const model = resolve(choice.provider, choice.model)
        collected = await collectModel(
          model,
          rendered.system,
          messages,
          tools,
          signal,
          runtime.modelRetry,
          runtime.metrics,
          runtime.modelGate,
          request.priority,
        )
        usedModel = { provider: model.provider.id, model: model.model.id }
        cost = addCost(cost, costOfUsage(
          model.model.pricing,
          collected.usage,
          pricedAt,
          runtime.profile.timeZone,
        ))
        break
      } catch (error) {
        lastError = error
      } finally {
        modelDurationMs += Date.now() - modelStarted
      }
    }

    if (!collected) {
      if (signal.aborted) {
        status = 'cancelled'
        errorText = 'aborted'
      } else {
        status = 'failed'
        errorText = lastError instanceof Error ? lastError.message : 'no model available'
      }
      break
    }

    usage.input += collected.usage.input
    usage.output += collected.usage.output
    usage.cacheRead += collected.usage.cacheRead

    if (collected.reasoning) {
      append({
        stream,
        actor: 'agent',
        type: 'thoughts.segment',
        payload: { text: collected.reasoning },
      })
    }

    if (collected.text) {
      lastText = collected.text
      append({
        stream,
        actor: 'agent',
        type: 'message.assistant',
        payload: { text: collected.text },
      })
    }

    const budget = preset.budget
    const totalTokens = usage.input + usage.output
    const exceeded = budget && (
      (budget.maxInputTokens !== undefined && usage.input > budget.maxInputTokens)
      || (budget.maxOutputTokens !== undefined && usage.output > budget.maxOutputTokens)
      || (budget.maxTotalTokens !== undefined && totalTokens > budget.maxTotalTokens)
    )
    if (exceeded) {
      status = 'failed'
      errorText = `budget_exceeded: input=${usage.input} output=${usage.output}`
      steps += 1
      break
    }

    steps += 1

    if (collected.calls.length === 0) {
      append({
        stream,
        actor: 'agent',
        type: 'agent.step',
        payload: { requestId: request.id, step: steps, note: 'model finished' },
      })
      break
    }

    // 同一模型响应里重复的 id 只执行一次；每个 step 的重复不回查历史，
    // 因为子 agent 可能在不同 step 里合法地复用同一个工具调用 id。
    const pending = collected.calls.filter((call, index) =>
      collected.calls.findIndex(item => item.id === call.id) === index,
    )
    const answered = new Set<string>()

    for (const call of pending) {
      append({
        stream,
        actor: 'agent',
        type: 'tool.call',
        payload: { callId: call.id, call: call.name, args: parseArguments(call.arguments) },
      })
    }
    flush()

    for (const call of pending) {
      const args = parseArguments(call.arguments)
      let result: ToolResult
      if (!allowed.has(call.name)) {
        result = { text: `tool not allowed: ${call.name}`, isError: true }
      } else try {
        result = await executeTool(call.name, args, {
          registry: runtime.tools,
          approvals: runtime.approvals,
          callId: call.id,
          sessionId: request.id,
          cwd: runtime.cwd,
          signal,
          ...(runtime.sandbox ? { sandbox: runtime.sandbox } : {}),
          ...(runtime.network ? { network: runtime.network } : {}),
          ...(runtime.leases ? { leases: runtime.leases } : {}),
          ...(runtime.workspaceId ? { workspaceId: runtime.workspaceId } : {}),
          ...(runtime.metrics ? { metrics: runtime.metrics } : {}),
          hooks: {
            guard: name => {
              const policy = runtime.tools.policy(name)
              if (policy?.approval !== 'required') return 'allow'
              // 危险工具默认拒绝；只有预设显式信任才放行。
              return preset.allowDangerousTools === true && !preset.readOnly
                ? 'allow'
                : 'deny'
            },
          },
        })
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), isError: true }
      }

      if (!result.isError && (call.name === 'write' || call.name === 'edit')) {
        const path = (args as { file_path?: unknown }).file_path
        if (typeof path === 'string') artifacts.add(path)
      }

      const finalResult = runtime.offload ? runtime.offload.apply(result) : result
      recordToolResultOnce({ append, stream, callId: call.id, result: finalResult, seen: answered })
    }

    append({
      stream,
      actor: 'agent',
      type: 'agent.step',
      payload: { requestId: request.id, step: steps, note: `${collected.calls.length} tool call(s)` },
    })
  }

  if (steps >= preset.maxSteps && status === 'completed') {
    status = 'failed'
    errorText = `hit maxSteps (${preset.maxSteps})`
  }

  flush()

  return {
    id: request.id,
    preset: request.preset,
    status,
    summary: (lastText || '（完成，无文本输出）').slice(0, 2000),
    artifacts: [...artifacts],
    usage,
    steps,
    stream: agentStream(request.id),
    ...(errorText ? { error: errorText } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(usedModel ? { model: usedModel } : {}),
    durationMs: Date.now() - runStartedMs,
    modelDurationMs,
    cost,
  }
}
