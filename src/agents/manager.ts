/**
 * 子 agent 调度器：请求队列、并发池、按来源/预设限流、状态与中断。
 *
 * 受理即返回；执行由池异步进行；终态写 agent 流并回送。
 *
 * @module if/agents/manager
 */

import { randomUUID } from 'node:crypto'
import type { Event, NewEvent } from '../core/events.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import { agentStream } from '../core/streams.ts'
import type { EventStore } from '../core/store.ts'
import {
  DEFAULT_AGENT_POOL,
  type AgentPoolConfig,
  type AgentPreset,
  type AgentRequest,
  type AgentResult,
} from './types.ts'

export interface AgentManagerOptions {
  readonly storeFactory: (id: string) => EventStore
  /** 每个 agent 流的单写者；不传则直接写 store */
  readonly writerFactory?: (id: string) => SessionWriter
  readonly runner: (
    request: AgentRequest,
    signal: AbortSignal,
    store: EventStore,
    stream: string,
    writer?: SessionWriter,
  ) => Promise<AgentResult>
  /** 终态回送：由调用方写入来源会话的系统消息 */
  readonly deliver?: (result: AgentResult, request: AgentRequest) => void
  readonly config?: Partial<AgentPoolConfig>
}

interface ActiveEntry {
  readonly request: AgentRequest
  readonly controller: AbortController
  readonly provider: string
}

export class AgentManager {
  private readonly options: AgentManagerOptions
  private readonly config: AgentPoolConfig
  private readonly queue: AgentRequest[] = []
  private readonly active = new Map<string, ActiveEntry>()
  private readonly requests = new Map<string, AgentRequest>()
  private readonly results = new Map<string, AgentResult>()
  private readonly runningProvider = new Map<string, number>()
  private readonly runningPreset = new Map<string, number>()
  private readonly writers = new Map<string, SessionWriter>()
  private pumping = false

  constructor(options: AgentManagerOptions) {
    this.options = options
    this.config = { ...DEFAULT_AGENT_POOL, ...options.config }
  }

  submit(
    input: Omit<AgentRequest, 'id' | 'createdAt' | 'snapshot'>,
    preset: AgentPreset,
  ): AgentRequest {
    if (this.queue.length >= this.config.queueLimit) {
      throw new Error(`agent queue full (${this.config.queueLimit})`)
    }

    const request: AgentRequest = {
      ...input,
      id: `agent-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      snapshot: preset,
    }

    this.requests.set(request.id, request)
    // 会话归用户所有；agent 只是创建者，createdBy 仅做溯源。
    if (!this.options.storeFactory(request.id).hasAnyEvents()) {
      this.append(request.id, {
        stream: agentStream(request.id),
        actor: 'system',
        type: 'session.created',
        payload: {
          sessionId: request.id,
          createdAt: request.createdAt,
          formatVersion: 2,
          seqBase: 0,
          createdBy: `agent:${request.preset}`,
          createdFrom: { sessionId: request.source.session },
          reason: 'agent request',
        },
      })
    }
    this.append(request.id, {
      stream: agentStream(request.id),
      actor: 'user',
      type: 'agent.requested',
      payload: {
        requestId: request.id,
        preset: request.preset,
        prompt: request.prompt,
        source: request.source,
        priority: request.priority,
      },
    })

    this.queue.push(request)
    void this.pump()
    return request
  }

  status(id: string): AgentResult | 'queued' | 'running' | undefined {
    return this.results.get(id)
      ?? (this.active.has(id) ? 'running' : undefined)
      ?? (this.queue.some(request => request.id === id) ? 'queued' : undefined)
  }

  interrupt(id: string): boolean {
    const active = this.active.get(id)
    if (active) {
      active.controller.abort(new Error('interrupted by request'))
      return true
    }

    const index = this.queue.findIndex(request => request.id === id)
    if (index < 0) return false

    const [request] = this.queue.splice(index, 1)
    const result: AgentResult = {
      id: request.id,
      preset: request.preset,
      status: 'cancelled',
      summary: '',
      artifacts: [],
      usage: { input: 0, output: 0, cacheRead: 0 },
      steps: 0,
      stream: agentStream(request.id),
      error: 'cancelled before start',
      finishedAt: new Date().toISOString(),
    }
    this.finish(result)
    return true
  }

  list(limit = 20): readonly (AgentResult | { id: string; preset: string; status: 'queued' | 'running' })[] {
    const out: (AgentResult | { id: string; preset: string; status: 'queued' | 'running' })[] = []
    for (const entry of this.active.values()) {
      out.push({ id: entry.request.id, preset: entry.request.preset, status: 'running' })
    }
    for (const request of this.queue) {
      out.push({ id: request.id, preset: request.preset, status: 'queued' })
    }
    const finished = [...this.results.values()].slice(-limit).reverse()
    return [...out, ...finished].slice(0, limit)
  }

  queueLength(): number {
    return this.queue.length
  }

  /** 关机：中断运行中的请求，清空队列，等待终态写入。 */
  async dispose(timeoutMs = 5_000): Promise<void> {
    for (const entry of this.active.values()) {
      entry.controller.abort(new Error('manager disposed'))
    }
    const started = Date.now()
    while (this.active.size > 0 && Date.now() - started < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    for (const request of [...this.queue]) this.interrupt(request.id)
    for (const id of [...this.writers.keys()]) this.closeWriter(id)
  }

  activeCount(): number {
    return this.active.size
  }

  private eligible(request: AgentRequest): boolean {
    if (this.active.size >= this.config.maxConcurrent) return false

    const provider = request.snapshot.models[0]?.provider ?? ''
    const providerLimit = this.config.perProvider[provider]
    if (providerLimit !== undefined && (this.runningProvider.get(provider) ?? 0) >= providerLimit) {
      return false
    }

    const presetLimit = this.config.perPreset[request.preset]
    if (presetLimit !== undefined && (this.runningPreset.get(request.preset) ?? 0) >= presetLimit) {
      return false
    }

    return true
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (true) {
        const index = this.queue.findIndex(request => this.eligible(request))
        if (index < 0) break
        const [request] = this.queue.splice(index, 1)
        this.start(request)
      }
    } finally {
      this.pumping = false
    }
  }

  private start(request: AgentRequest): void {
    const controller = new AbortController()
    const provider = request.snapshot.models[0]?.provider ?? ''
    this.active.set(request.id, { request, controller, provider })
    this.runningProvider.set(provider, (this.runningProvider.get(provider) ?? 0) + 1)
    this.runningPreset.set(request.preset, (this.runningPreset.get(request.preset) ?? 0) + 1)

    const writer = this.writerFor(request.id)
    const store = writer?.store ?? this.options.storeFactory(request.id)
    const stream = agentStream(request.id)
    const startedAt = new Date().toISOString()
    // 预设的超时是硬上限：到点中断，状态记 failed 而不是 cancelled。
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`agent timeout after ${request.snapshot.timeoutMs}ms`))
    }, request.snapshot.timeoutMs)
    this.append(request.id, {
      stream,
      actor: 'agent',
      type: 'agent.started',
      payload: { requestId: request.id, preset: request.preset, startedAt },
    })

    void (async () => {
      let result: AgentResult
      try {
        const produced = await this.options.runner(request, controller.signal, store, stream, writer)
        // 身份以 manager 的请求为准，不信任 runner 返回的 id；超时统一记 failed。
        result = {
          ...produced,
          id: request.id,
          preset: request.preset,
          stream,
          ...(timedOut
            ? {
              status: 'failed' as const,
              error: `timeout after ${request.snapshot.timeoutMs}ms`,
              finishedAt: new Date().toISOString(),
            }
            : {}),
        }
      } catch (error) {
        result = {
          id: request.id,
          preset: request.preset,
          status: controller.signal.aborted && !timedOut ? 'cancelled' : 'failed',
          summary: '',
          artifacts: [],
          usage: { input: 0, output: 0, cacheRead: 0 },
          steps: 0,
          stream,
          error: timedOut
            ? `timeout after ${request.snapshot.timeoutMs}ms`
            : error instanceof Error ? error.message : String(error),
          startedAt,
          finishedAt: new Date().toISOString(),
        }
      } finally {
        clearTimeout(timer)
      }
      // 先写终态/关写者，再释放并发名额；否则 dispose 可能在终态写入前关锁。
      try {
        this.finish(result)
      } finally {
        this.release(request)
      }
    })()
  }

  private release(request: AgentRequest): void {
    const entry = this.active.get(request.id)
    if (!entry) return
    this.active.delete(request.id)
    this.runningProvider.set(entry.provider, Math.max(0, (this.runningProvider.get(entry.provider) ?? 1) - 1))
    this.runningPreset.set(request.preset, Math.max(0, (this.runningPreset.get(request.preset) ?? 1) - 1))
    void this.pump()
  }

  private finish(result: AgentResult): void {
    if (this.results.has(result.id)) return
    this.results.set(result.id, result)

    const stream = agentStream(result.id)
    const type = result.status === 'completed'
      ? 'agent.completed'
      : result.status === 'cancelled'
        ? 'agent.cancelled'
        : result.status === 'interrupted'
          ? 'agent.interrupted'
          : 'agent.failed'

    this.append(result.id, {
      stream,
      actor: 'agent',
      type,
      payload: {
        requestId: result.id,
        preset: result.preset,
        summary: result.summary,
        artifacts: result.artifacts,
        usage: result.usage,
        steps: result.steps,
        ...(result.error ? { error: result.error } : {}),
      },
    })
    const terminalWriter = this.writerFor(result.id)
    if (terminalWriter) terminalWriter.flush()
    else this.options.storeFactory(result.id).flush()
    // agent 流到此结束，释放写者锁；后续只读。
    this.closeWriter(result.id)

    const request = this.requests.get(result.id)
    if (request) this.options.deliver?.(result, request)
    void this.pump()
  }

  private writerFor(id: string): SessionWriter | undefined {
    if (!this.options.writerFactory) return undefined
    const existing = this.writers.get(id)
    if (existing && !existing.closed) return existing
    const writer = this.options.writerFactory(id)
    this.writers.set(id, writer)
    return writer
  }

  private append(id: string, input: NewEvent): Event {
    const writer = this.writerFor(id)
    return writer ? writer.append(input) : this.options.storeFactory(id).append(input)
  }

  private closeWriter(id: string): void {
    const writer = this.writers.get(id)
    if (!writer) return
    this.writers.delete(id)
    writer.close()
  }
}
