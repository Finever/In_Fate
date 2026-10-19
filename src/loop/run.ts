/**
 * 对话循环：模型 → 事件 → 工具 → 回填 → 再请求。
 *
 * 每一轮都从事件流重新投影历史，不在内存里攒上下文。
 * 工具结果先落事件，下一步再被投影回模型；悬空调用由投影补中断结果。
 *
 * @module if/loop/run
 */

import type { Profile } from '../config/profile.ts'
import { renderContext, type RenderOptions } from '../context/pipeline.ts'
import type { TokenEstimator } from '../compaction/estimate.ts'
import { compactIfNeeded } from '../compaction/fold.ts'
import type { CompactionConfig, Summarizer } from '../compaction/types.ts'
import type { SpillPolicy } from '../tools/spill.ts'
import type { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { chatOpenAI, type ChatRequest } from '../model/openai.ts'
import type { ResolvedModel } from '../model/registry.ts'
import type { ModelEvent } from '../model/types.ts'
import { projectHistory } from '../projections/history.ts'
import type { ApprovalRegistry, ToolResult } from '../tools/types.ts'
import { executeTool } from '../tools/executor.ts'
import type { ToolRegistry } from '../tools/registry.ts'

export interface RunLoopOptions {
  readonly store: EventStore
  readonly sessionId: string
  readonly profile: Profile
  readonly model: ResolvedModel
  readonly tools: ToolRegistry
  readonly approvals: ApprovalRegistry
  readonly sections: RenderOptions['sections']
  readonly cwd?: string
  /** 防死循环：一步 = 一次模型请求 */
  readonly maxSteps?: number
  /** 上下文总字节预算；不传用管线默认值 */
  readonly maxBytes?: number
  readonly signal?: AbortSignal
  /** 注入时间，保持可复现；默认读系统时间 */
  readonly now?: () => Date
  /** 流式回调，给 UI 用 */
  readonly onModelEvent?: (event: ModelEvent) => void
  /** 压缩配置；不传就不压 */
  readonly compaction?: {
    readonly config: CompactionConfig
    readonly estimator: TokenEstimator
    readonly contextWindow: number
    readonly maxOutputTokens?: number
    readonly spill?: SpillPolicy
    readonly summarizer?: Summarizer
  }
}

export interface RunUsage {
  input: number
  output: number
  cacheRead: number
}

export interface RunResult {
  readonly steps: number
  readonly usage: RunUsage
  readonly aborted: boolean
  readonly hitLimit: boolean
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function runTurn(userText: string, options: RunLoopOptions): Promise<RunResult> {
  const now = options.now ?? ((): Date => new Date())
  const stream = sessionStream(options.sessionId)
  const userId = options.profile.principals.user?.id ?? 'user'
  const agentId = options.profile.principals.agents?.[0]?.id ?? 'agent'
  const cwd = options.cwd ?? process.cwd()
  const maxSteps = options.maxSteps ?? 32

  options.store.append({
    stream,
    actor: 'user',
    actorId: userId,
    type: 'message.user',
    payload: { text: userText },
  })

  // 轮开始前做一次压缩检查；失败要落痕，但不能阻塞这一轮。
  const currentTurn = options.store.read().filter(event => event.type === 'turn.completed').length + 1
  if (options.compaction) {
    try {
      const history = projectHistory(options.store.read())
      const rendered = renderContext({
        sections: options.sections,
        history,
        profile: options.profile,
        sessionId: options.sessionId,
        turn: 1,
        now: now(),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      })
      await compactIfNeeded({
        store: options.store,
        stream,
        config: options.compaction.config,
        estimator: options.compaction.estimator,
        contextWindow: options.compaction.contextWindow,
        ...(options.compaction.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.compaction.maxOutputTokens } : {}),
        system: rendered.system,
        tools: options.tools.toModelSpecs(),
        messages: rendered.messages,
        currentTurn,
        projectMessages: () => projectHistory(options.store.read()),
        ...(options.compaction.summarizer ? { summarizer: options.compaction.summarizer } : {}),
        ...(options.compaction.spill ? { spill: options.compaction.spill } : {}),
      })
    } catch (error) {
      options.store.append({
        stream,
        actor: 'system',
        type: 'compaction.failed',
        payload: {
          reason: error instanceof Error ? error.message : String(error),
          turn: currentTurn,
        },
      })
    }
  }

  const usage: RunUsage = { input: 0, output: 0, cacheRead: 0 }
  let steps = 0
  let hitLimit = false

  while (steps < maxSteps) {
    if (options.signal?.aborted) break

    // 每一步都从事件流重新投影：真相只有一份。
    const history = projectHistory(options.store.read())
    const rendered = renderContext({
      sections: options.sections,
      history,
      profile: options.profile,
      sessionId: options.sessionId,
      turn: steps + 1,
      now: now(),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    })

    const request: ChatRequest = {
      resolved: options.model,
      system: rendered.system,
      messages: rendered.messages,
      tools: options.tools.toModelSpecs(),
      signal: options.signal,
    }

    const text: string[] = []
    const reasoning: string[] = []
    const calls: { id: string; name: string; arguments: string }[] = []

    for await (const event of chatOpenAI(request)) {
      options.onModelEvent?.(event)
      if (event.type === 'text') text.push(event.text)
      else if (event.type === 'reasoning') reasoning.push(event.text)
      else if (event.type === 'tool_call') calls.push(event)
      else if (event.type === 'usage') {
        usage.input += event.input ?? 0
        usage.output += event.output ?? 0
        usage.cacheRead += event.cacheRead ?? 0
      }
    }

    if (reasoning.length > 0) {
      options.store.append({
        stream,
        actor: 'agent',
        actorId: agentId,
        type: 'thoughts.segment',
        payload: { text: reasoning.join('') },
      })
    }

    if (text.length > 0) {
      options.store.append({
        stream,
        actor: 'agent',
        actorId: agentId,
        type: 'message.assistant',
        payload: { text: text.join('') },
      })
    }

    steps += 1
    if (calls.length === 0) break

    for (const call of calls) {
      options.store.append({
        stream,
        actor: 'agent',
        actorId: agentId,
        type: 'tool.call',
        payload: { callId: call.id, call: call.name, args: parseArguments(call.arguments) },
      })
    }

    for (const call of calls) {
      let result: ToolResult
      try {
        result = await executeTool(call.name, parseArguments(call.arguments), {
          registry: options.tools,
          approvals: options.approvals,
          callId: call.id,
          sessionId: options.sessionId,
          cwd,
          signal: options.signal,
        })
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), isError: true }
      }

      options.store.append({
        stream,
        actor: 'tool',
        type: 'tool.result',
        refs: { toolCall: call.id },
        payload: {
          callId: call.id,
          text: result.text ?? '',
          isError: result.isError ?? false,
          ...(result.structured !== undefined ? { structured: result.structured } : {}),
          ...(result.mime ? { mime: result.mime } : {}),
        },
      })
    }
  }

  if (steps >= maxSteps) hitLimit = true

  options.store.append({
    stream,
    actor: 'system',
    type: 'turn.completed',
    payload: { steps, usage, aborted: options.signal?.aborted ?? false, hitLimit },
  })

  return { steps, usage, aborted: options.signal?.aborted ?? false, hitLimit }
}
