/**
 * 模型请求准入：provider 级并发、排队、速率与共享退避。
 *
 * 目的不是限制单会话，而是防止多个会话同时把同一个网关打爆：
 *   - 每个 provider 最多 N 个进行中的请求；
 *   - 可选每分钟请求数；
 *   - 429/5xx 后整个 provider 共享 cooldown；
 *   - 主交互优先于普通任务，后台最后。
 *
 * @module if/model/gate
 */

import { ModelHttpError } from './retry.ts'

export type ModelPriority = 'interactive' | 'normal' | 'background'

export interface ProviderLimit {
  readonly maxConcurrent?: number
  readonly requestsPerMinute?: number
}

export interface ModelGateOptions {
  readonly maxConcurrentPerProvider?: number
  readonly requestsPerMinute?: number
  readonly queueLimit?: number
  readonly waitMs?: number
  readonly cooldownBaseMs?: number
  readonly cooldownMaxMs?: number
  readonly providers?: Readonly<Record<string, ProviderLimit>>
}

export interface GateAcquireInput {
  readonly providerId: string
  readonly priority?: ModelPriority
  readonly signal?: AbortSignal
}

export interface GateSnapshot {
  readonly providerId: string
  readonly active: number
  readonly queued: number
  readonly cooldownMs: number
  readonly failures: number
  readonly tokens: number
}

interface Waiter {
  readonly providerId: string
  readonly priority: ModelPriority
  readonly sequence: number
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  timer?: NodeJS.Timeout
  onAbort?: () => void
}

interface ProviderState {
  active: number
  readonly queue: Waiter[]
  cooldownUntil: number
  failures: number
  tokens: number
  lastRefill: number
  cooldownTimer?: NodeJS.Timeout
}

const PRIORITY: Record<ModelPriority, number> = {
  interactive: 0,
  normal: 1,
  background: 2,
}

const DEFAULTS = {
  maxConcurrentPerProvider: 3,
  queueLimit: 64,
  waitMs: 120_000,
  cooldownBaseMs: 1_000,
  cooldownMaxMs: 60_000,
}

export class ModelGate {
  private readonly options: ModelGateOptions
  private readonly states = new Map<string, ProviderState>()
  private sequence = 0

  constructor(options: ModelGateOptions = {}) {
    this.options = options
  }

  acquire(input: GateAcquireInput): Promise<() => void> {
    const state = this.state(input.providerId)
    const priority = input.priority ?? 'normal'
    const limit = this.limit(input.providerId)

    if (input.signal?.aborted) {
      return Promise.reject(input.signal.reason ?? new Error('model gate aborted'))
    }

    // 有排队时不能插队，避免后台任务持续抢新请求。
    if (state.queue.length === 0 && this.canAcquire(state, limit)) {
      return Promise.resolve(this.grant(input.providerId, state, limit))
    }

    if (state.queue.length >= (this.options.queueLimit ?? DEFAULTS.queueLimit)) {
      return Promise.reject(new Error(`model gate queue full: ${input.providerId}`))
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        providerId: input.providerId,
        priority,
        sequence: this.sequence++,
        resolve,
        reject,
        ...(input.signal ? { signal: input.signal } : {}),
      }

      const cleanup = (): void => {
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        const index = state.queue.indexOf(waiter)
        if (index >= 0) state.queue.splice(index, 1)
      }

      waiter.onAbort = () => {
        cleanup()
        reject(input.signal?.reason ?? new Error('model gate aborted'))
      }
      input.signal?.addEventListener('abort', waiter.onAbort, { once: true })

      waiter.timer = setTimeout(() => {
        cleanup()
        reject(new Error(`model gate timeout: ${input.providerId}`))
      }, this.options.waitMs ?? DEFAULTS.waitMs)
      waiter.timer.unref?.()

      state.queue.push(waiter)
      state.queue.sort((a, b) =>
        PRIORITY[a.priority] - PRIORITY[b.priority] || a.sequence - b.sequence)
      this.scheduleDrain(input.providerId, state, limit)
    })
  }

  noteSuccess(providerId: string): void {
    const state = this.states.get(providerId)
    if (!state) return
    state.failures = 0
    state.cooldownUntil = 0
    if (state.cooldownTimer) clearTimeout(state.cooldownTimer)
    state.cooldownTimer = undefined
    this.drain(providerId, state)
  }

  noteError(providerId: string, error: unknown): void {
    const state = this.states.get(providerId)
    if (!state) return
    const status = error instanceof ModelHttpError ? error.status : undefined
    if (status !== 429 && status !== 500 && status !== 502 && status !== 503 && status !== 504) {
      return
    }

    state.failures += 1
    const base = this.options.cooldownBaseMs ?? DEFAULTS.cooldownBaseMs
    const max = this.options.cooldownMaxMs ?? DEFAULTS.cooldownMaxMs
    const retryAfter = error instanceof ModelHttpError ? error.retryAfterMs ?? 0 : 0
    const delay = Math.min(max, Math.max(retryAfter, base * 2 ** (state.failures - 1)))
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + delay)

    if (state.cooldownTimer) clearTimeout(state.cooldownTimer)
    state.cooldownTimer = setTimeout(() => {
      state.cooldownTimer = undefined
      this.drain(providerId, state)
    }, delay)
    state.cooldownTimer.unref?.()
  }

  snapshot(): GateSnapshot[] {
    return [...this.states.entries()].map(([providerId, state]) => ({
      providerId,
      active: state.active,
      queued: state.queue.length,
      cooldownMs: Math.max(0, state.cooldownUntil - Date.now()),
      failures: state.failures,
      tokens: Math.floor(state.tokens),
    }))
  }

  dispose(): void {
    const error = new Error('model gate disposed')
    for (const [providerId, state] of this.states) {
      state.queue.splice(0).forEach(waiter => {
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(error)
      })
      if (state.cooldownTimer) clearTimeout(state.cooldownTimer)
      this.states.delete(providerId)
    }
  }

  private state(providerId: string): ProviderState {
    let state = this.states.get(providerId)
    if (!state) {
      state = {
        active: 0,
        queue: [],
        cooldownUntil: 0,
        failures: 0,
        tokens: 0,
        lastRefill: 0,
      }
      this.states.set(providerId, state)
    }
    return state
  }

  private limit(providerId: string): Required<ProviderLimit> {
    const override = this.options.providers?.[providerId]
    return {
      maxConcurrent: Math.max(1, override?.maxConcurrent
        ?? this.options.maxConcurrentPerProvider
        ?? DEFAULTS.maxConcurrentPerProvider),
      requestsPerMinute: Math.max(0, override?.requestsPerMinute
        ?? this.options.requestsPerMinute
        ?? 0),
    }
  }

  private canAcquire(state: ProviderState, limit: Required<ProviderLimit>): boolean {
    if (state.active >= limit.maxConcurrent) return false
    if (Date.now() < state.cooldownUntil) return false
    this.refill(state, limit.requestsPerMinute)
    return limit.requestsPerMinute === 0 || state.tokens >= 1
  }

  private grant(providerId: string, state: ProviderState, limit: Required<ProviderLimit>): () => void {
    state.active += 1
    if (limit.requestsPerMinute > 0) state.tokens = Math.max(0, state.tokens - 1)
    let released = false
    return () => {
      if (released) return
      released = true
      state.active = Math.max(0, state.active - 1)
      this.drain(providerId, state)
    }
  }

  private refill(state: ProviderState, requestsPerMinute: number): void {
    if (requestsPerMinute <= 0) return
    const now = Date.now()
    if (state.lastRefill === 0) {
      state.tokens = requestsPerMinute
      state.lastRefill = now
      return
    }
    const elapsed = now - state.lastRefill
    if (elapsed <= 0) return
    state.tokens = Math.min(
      requestsPerMinute,
      state.tokens + (elapsed * requestsPerMinute) / 60_000,
    )
    state.lastRefill = now
  }

  private scheduleDrain(providerId: string, state: ProviderState, limit: Required<ProviderLimit>): void {
    if (state.queue.length === 0) return
    const tokenWait = limit.requestsPerMinute > 0 && state.tokens < 1
      ? Math.ceil((1 - state.tokens) * 60_000 / limit.requestsPerMinute)
      : 0
    const cooldownWait = Math.max(0, state.cooldownUntil - Date.now())
    const wait = Math.max(tokenWait, cooldownWait)
    if (wait <= 0) return
    const timer = setTimeout(() => this.drain(providerId, state), wait)
    timer.unref?.()
  }

  private drain(providerId: string, state: ProviderState): void {
    const limit = this.limit(providerId)
    while (state.queue.length > 0) {
      const waiter = state.queue[0]!
      if (!this.canAcquire(state, limit)) break
      state.queue.shift()
      if (waiter.timer) clearTimeout(waiter.timer)
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.onAbort = undefined
      }
      waiter.resolve(this.grant(providerId, state, limit))
    }
    if (state.queue.length > 0) this.scheduleDrain(providerId, state, limit)
  }
}
