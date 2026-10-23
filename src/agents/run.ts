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
import type { Event, NewEvent } from '../core/events.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import type { EventStore } from '../core/store.ts'
import { agentStream } from '../core/streams.ts'
import { chatOpenAI } from '../model/openai.ts'
import { resolveModel, type ModelRegistry, type ResolvedModel } from '../model/registry.ts'
import type { ModelEvent, ToolSpec } from '../model/types.ts'
import { projectHistory } from '../projections/history.ts'
import { executeTool } from '../tools/executor.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ApprovalRegistry, ToolResult } from '../tools/types.ts'
import type { OffloadPolicy } from '../tools/offload.ts'
import { toolResultPayload } from '../tools/result-payload.ts'
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
  /** 传了就用实例注册表；不传退回模块级默认实例（旧 demo 兼容） */
  readonly models?: ModelRegistry
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
  messages: Parameters<typeof chatOpenAI>[0]['messages'],
  tools: readonly ToolSpec[],
  signal: AbortSignal,
): Promise<Collected> {
  const text: string[] = []
  const reasoning: string[] = []
  const calls: { id: string; name: string; arguments: string }[] = []
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0 }

  for await (const event of chatOpenAI({ resolved: model, system, messages, tools, signal })) {
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
    if (name === 'request_agent' || name.startsWith('agent_')) return false
    if (preset.readOnly && writeTools.has(name)) return false
    const policy = tools.policy(name)
    if (policy?.approval === 'required' && preset.allowDangerousTools !== true) return false
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
  const append = (input: NewEvent): Event =>
    runtime.writer ? runtime.writer.append(input) : store.append(input)
  const flush = (): void => {
    if (runtime.writer) runtime.writer.flush()
    else store.flush()
  }

  const resolve = runtime.models
    ? (provider: string, model: string): ResolvedModel => runtime.models!.resolve(provider, model)
    : resolveModel

  const startedAt = new Date().toISOString()
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0 }
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

    const tools = runtime.tools.toModelSpecs().filter(spec => allowed.has(spec.name))
    let collected: Collected | undefined
    let lastError: unknown

    // 模型候选链：只在本步没有执行任何工具前降级，避免副作用重放。
    for (const choice of preset.models) {
      if (signal.aborted) break
      try {
        const model = resolve(choice.provider, choice.model)
        collected = await collectModel(model, rendered.system, rendered.messages, tools, signal)
        break
      } catch (error) {
        lastError = error
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

    for (const call of collected.calls) {
      append({
        stream,
        actor: 'agent',
        type: 'tool.call',
        payload: { callId: call.id, call: call.name, args: parseArguments(call.arguments) },
      })
    }
    flush()

    for (const call of collected.calls) {
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
      append({
        stream,
        actor: 'tool',
        type: 'tool.result',
        refs: { toolCall: call.id },
        payload: toolResultPayload(call.id, finalResult),
      })
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
  }
}
