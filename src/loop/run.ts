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
import { archiveCompactedSegments } from '../compaction/archive.ts'
import { compactIfNeeded } from '../compaction/fold.ts'
import type { CompactionConfig, Summarizer } from '../compaction/types.ts'
import type { SpillPolicy } from '../tools/spill.ts'
import type { Event, NewEvent } from '../core/events.ts'
import type { Metrics } from '../core/metrics.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import type { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { chatOpenAI, type ChatRequest } from '../model/openai.ts'
import type { ResolvedModel } from '../model/registry.ts'
import type { ModelRetryPolicy } from '../model/retry.ts'
import type { ModelEvent } from '../model/types.ts'
import { projectHistory } from '../projections/history.ts'
import type {
  ApprovalRegistry,
  NetworkGuard,
  PathSandbox,
  ToolResult,
} from '../tools/types.ts'
import { executeTool } from '../tools/executor.ts'
import type { OffloadPolicy } from '../tools/offload.ts'
import { recordToolResultOnce, toolCallIdsWithResults } from '../tools/persist.ts'
import type { ToolRegistry } from '../tools/registry.ts'

export interface RunLoopOptions {
  readonly store: EventStore
  /** 会话写者；不传则直接写 store（demo/单测兼容） */
  readonly writer?: SessionWriter
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
  /** 工具结果写时卸载；不传就全内联 */
  readonly offload?: OffloadPolicy
  /** 模型重试/超时；不传由适配器用默认策略 */
  readonly modelRetry?: ModelRetryPolicy
  readonly sandbox?: PathSandbox
  readonly network?: NetworkGuard
  readonly metrics?: Metrics
  readonly signal?: AbortSignal
  /** 触发事件已由调用方写入（跨会话消息/唤醒），本轮不再追加 message.user */
  readonly skipStartEvent?: boolean
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
  /** 模型请求失败的原因；失败也会落一条 turn.completed */
  readonly error?: string
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function runTurn(userText: string, options: RunLoopOptions): Promise<RunResult> {
  const startedAt = Date.now()
  options.metrics?.inc('turn.started')
  const now = options.now ?? ((): Date => new Date())
  const stream = sessionStream(options.sessionId)
  const userId = options.profile.principals.user?.id ?? 'user'
  const agentId = options.profile.principals.agents?.[0]?.id ?? 'agent'
  const cwd = options.cwd ?? process.cwd()
  const maxSteps = options.maxSteps ?? 32
  const append = (input: NewEvent): Event =>
    options.writer ? options.writer.append(input) : options.store.append(input)
  const flush = (): void => {
    if (options.writer) options.writer.flush()
    else options.store.flush()
  }

  if (!options.skipStartEvent) {
    append({
      stream,
      actor: 'user',
      actorId: userId,
      type: 'message.user',
      payload: { text: userText },
    })
  }

  // 本轮已产生结果的调用 id；重放时不再执行第二次副作用。
  const turnEvents = options.store.read()
  let turnStart = 0
  turnEvents.forEach((event, index) => {
    if (event.type === 'turn.completed') turnStart = index + 1
  })
  const answered = toolCallIdsWithResults(turnEvents.slice(turnStart))

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
        ...(options.writer ? { writer: options.writer } : {}),
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
      append({
        stream,
        actor: 'system',
        type: 'compaction.failed',
        payload: {
          reason: error instanceof Error ? error.message : String(error),
          turn: currentTurn,
        },
      })
    }

    // 压缩链已覆盖的旧段可以退出活跃读取；失败只影响性能，不影响这一轮。
    try {
      archiveCompactedSegments(options.store)
    } catch {
      // 归档是优化，不是正确性前置条件
    }
  }

  // 模型请求前先落盘：请求发出后崩溃，用户消息和压缩结果不会丢。
  flush()

  const usage: RunUsage = { input: 0, output: 0, cacheRead: 0 }
  let steps = 0
  let hitLimit = false
  let failure: string | undefined
  /** 最后一轮模型请求实际看到的事件 seq；给跨会话唤醒判断是否已读。 */
  let lastSeenSeq = -1

  while (steps < maxSteps) {
    if (options.signal?.aborted) break
    flush()

    // 每一步都从事件流重新投影：真相只有一份。
    const snapshot = options.store.read()
    lastSeenSeq = snapshot.at(-1)?.seq ?? Math.max(0, snapshot.length - 1)
    const history = projectHistory(snapshot)
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
      ...(options.modelRetry ? { retry: options.modelRetry } : {}),
      onAttempt: () => options.metrics?.inc('model.attempts'),
      onRetry: info => {
        options.metrics?.inc('model.retries')
        options.metrics?.observe('model.retry_delay_ms', info.delayMs,
          info.status !== undefined ? { status: info.status } : {})
      },
    }

    const text: string[] = []
    const reasoning: string[] = []
    const calls: { id: string; name: string; arguments: string }[] = []
    let stepInput = 0
    const modelStarted = Date.now()

    try {
      for await (const event of chatOpenAI(request)) {
        options.onModelEvent?.(event)
        if (event.type === 'text') text.push(event.text)
        else if (event.type === 'reasoning') reasoning.push(event.text)
        else if (event.type === 'tool_call') calls.push(event)
        else if (event.type === 'usage') {
          usage.input += event.input ?? 0
          usage.output += event.output ?? 0
          usage.cacheRead += event.cacheRead ?? 0
          stepInput += event.input ?? 0
        }
      }
      options.metrics?.inc('model.ok')
    } catch (error) {
      options.metrics?.inc('model.errors')
      // 用户中断不算失败；其它错误落痕后结束这一轮，不把异常漏给调用方。
      if (options.signal?.aborted) break
      failure = error instanceof Error ? error.message : String(error)
      break
    } finally {
      options.metrics?.observe('model.duration_ms', Date.now() - modelStarted)
    }

    // 用真实 usage 校准估算器；没有 usage 的提供方保持原系数。
    if (stepInput > 0 && options.compaction) {
      const chars = JSON.stringify(request.messages).length
        + request.system.length
        + JSON.stringify(request.tools).length
      options.compaction.estimator.observe(chars, stepInput)
    }

    if (reasoning.length > 0) {
      append({
        stream,
        actor: 'agent',
        actorId: agentId,
        type: 'thoughts.segment',
        payload: { text: reasoning.join('') },
      })
    }

    if (text.length > 0) {
      append({
        stream,
        actor: 'agent',
        actorId: agentId,
        type: 'message.assistant',
        payload: { text: text.join('') },
      })
    }

    steps += 1
    if (calls.length === 0) break

    const pending = calls.filter((call, index) =>
      !answered.has(call.id) && calls.findIndex(item => item.id === call.id) === index,
    )
    if (pending.length < calls.length) {
      options.metrics?.inc('tool.skipped_duplicate', calls.length - pending.length)
    }

    for (const call of pending) {
      append({
        stream,
        actor: 'agent',
        actorId: agentId,
        type: 'tool.call',
        payload: { callId: call.id, call: call.name, args: parseArguments(call.arguments) },
      })
    }
    // 工具正文执行前落盘：外部副作用发生后崩溃，调用意图仍在。
    flush()

    for (const call of pending) {
      let result: ToolResult
      try {
        result = await executeTool(call.name, parseArguments(call.arguments), {
          registry: options.tools,
          approvals: options.approvals,
          callId: call.id,
          sessionId: options.sessionId,
          cwd,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.network ? { network: options.network } : {}),
          ...(options.metrics ? { metrics: options.metrics } : {}),
        })
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), isError: true }
      }

      const finalResult = options.offload ? options.offload.apply(result) : result
      recordToolResultOnce({ append, stream, callId: call.id, result: finalResult, seen: answered })
    }
  }

  if (steps >= maxSteps) hitLimit = true
  const aborted = options.signal?.aborted ?? false

  append({
    stream,
    actor: 'system',
    type: 'turn.completed',
    payload: {
      steps,
      usage,
      aborted,
      hitLimit,
      lastSeenSeq,
      ...(failure ? { error: failure } : {}),
    },
  })

  flush()

  options.metrics?.inc('turn.steps', steps)
  options.metrics?.observe('turn.duration_ms', Date.now() - startedAt)
  options.metrics?.inc(failure ? 'turn.failed' : aborted ? 'turn.aborted' : 'turn.completed')

  return {
    steps,
    usage,
    aborted,
    hitLimit,
    ...(failure ? { error: failure } : {}),
  }
}
