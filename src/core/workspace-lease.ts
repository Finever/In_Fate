import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export type LeaseScope = 'path' | 'workspace'

export interface WorkspaceLeaseOptions {
  readonly pathTtlMs?: number
  readonly workspaceTtlMs?: number
  readonly waitMs?: number
  readonly renewMs?: number
  readonly maxQueue?: number
}

export interface LeaseRequest {
  readonly workspaceId: string
  readonly scope: LeaseScope
  readonly target?: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly ttlMs?: number
  readonly signal?: AbortSignal
}

export interface WorkspaceLeaseHandle {
  readonly leaseId: string
  readonly workspaceId: string
  readonly scope: LeaseScope
  readonly target?: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly acquiredAt: string
  readonly expiresAt: string
  release(): void
  renew(): void
}

export interface WorkspaceLeaseSnapshot {
  readonly leaseId: string
  readonly workspaceId: string
  readonly scope: LeaseScope
  readonly target?: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly acquiredAt: string
  readonly expiresAt: string
}

interface LeaseRecord {
  readonly leaseId: string
  readonly workspaceId: string
  readonly scope: LeaseScope
  readonly target?: string
  readonly key: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly ttlMs: number
  readonly acquiredAt: string
  expiresAt: string
  timer?: NodeJS.Timeout
}

interface Waiter {
  readonly workspaceId: string
  readonly scope: LeaseScope
  readonly key: string
  readonly target?: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly ttlMs: number
  readonly resolve: (lease: WorkspaceLeaseHandle) => void
  readonly reject: (error: Error) => void
  timer?: NodeJS.Timeout
  readonly signal?: AbortSignal
  onAbort?: () => void
}

interface WorkspaceState {
  readonly workspaceId: string
  readonly paths: Map<string, LeaseRecord>
  workspaceLease?: LeaseRecord
  readonly waiters: Waiter[]
}

const DEFAULT_PATH_TTL = 30_000
const DEFAULT_WORKSPACE_TTL = 300_000
const DEFAULT_WAIT = 30_000
const DEFAULT_RENEW = 5_000
const DEFAULT_MAX_QUEUE = 20

function normalizeTarget(target: string): string {
  let absolute = resolve(target)
  try {
    absolute = realpathSync.native(absolute)
  } catch {
    // 写目标可能还不存在；用词法绝对路径。
  }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function leaseHandle(manager: WorkspaceLeaseManager, record: LeaseRecord): WorkspaceLeaseHandle {
  return {
    leaseId: record.leaseId,
    workspaceId: record.workspaceId,
    scope: record.scope,
    ...(record.target ? { target: record.target } : {}),
    sessionId: record.sessionId,
    toolCallId: record.toolCallId,
    acquiredAt: record.acquiredAt,
    get expiresAt() {
      return record.expiresAt
    },
    release: () => manager.release(record.leaseId),
    renew: () => manager.renew(record.leaseId),
  }
}

export class WorkspaceLeaseManager {
  readonly pathTtlMs: number
  readonly workspaceTtlMs: number
  readonly waitMs: number
  readonly renewMs: number
  readonly maxQueue: number
  private readonly states = new Map<string, WorkspaceState>()

  constructor(options: WorkspaceLeaseOptions = {}) {
    this.pathTtlMs = Math.max(1, options.pathTtlMs ?? DEFAULT_PATH_TTL)
    this.workspaceTtlMs = Math.max(1, options.workspaceTtlMs ?? DEFAULT_WORKSPACE_TTL)
    this.waitMs = Math.max(0, options.waitMs ?? DEFAULT_WAIT)
    this.renewMs = Math.max(1, options.renewMs ?? DEFAULT_RENEW)
    this.maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE)
  }

  acquire(request: LeaseRequest): Promise<WorkspaceLeaseHandle> {
    const workspaceId = request.workspaceId
    const state = this.stateFor(workspaceId)
    const target = request.scope === 'path'
      ? (request.target ? normalizeTarget(request.target) : undefined)
      : undefined
    if (request.scope === 'path' && !target) {
      return Promise.reject(new Error('path lease needs a target'))
    }
    const key = target ?? '__workspace__'
    const ttlMs = Math.max(1, request.ttlMs ?? (
      request.scope === 'path' ? this.pathTtlMs : this.workspaceTtlMs
    ))

    // 队列非空时不能插队；FIFO 保证整仓请求不会被无限路径写饿死。
    if (state.waiters.length === 0 && this.canAcquire(state, request.scope, key)) {
      return Promise.resolve(this.grant(state, request, key, target, ttlMs))
    }

    if (state.waiters.length >= this.maxQueue) {
      return Promise.reject(new Error(`workspace lease queue full: ${workspaceId}`))
    }

    if (request.signal?.aborted) {
      return Promise.reject(request.signal.reason ?? new Error('workspace lease aborted'))
    }

    return new Promise<WorkspaceLeaseHandle>((resolvePromise, rejectPromise) => {
      const waiter: Waiter = {
        workspaceId,
        scope: request.scope,
        key,
        ...(target ? { target } : {}),
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        ttlMs,
        resolve: resolvePromise,
        reject: rejectPromise,
        ...(request.signal ? { signal: request.signal } : {}),
      }

      const cleanup = (): void => {
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        const index = state.waiters.indexOf(waiter)
        if (index >= 0) state.waiters.splice(index, 1)
      }

      waiter.onAbort = () => {
        cleanup()
        rejectPromise(request.signal?.reason ?? new Error('workspace lease aborted'))
      }
      request.signal?.addEventListener('abort', waiter.onAbort, { once: true })

      waiter.timer = setTimeout(() => {
        cleanup()
        rejectPromise(new Error(
          `workspace lease timeout: ${workspaceId} ${request.scope}${target ? ` ${target}` : ''}`,
        ))
      }, this.waitMs)
      waiter.timer.unref?.()

      state.waiters.push(waiter)
    })
  }

  renew(leaseId: string): void {
    const found = this.find(leaseId)
    if (!found) return
    const { state, record } = found
    record.expiresAt = new Date(Date.now() + record.ttlMs).toISOString()
    this.scheduleExpiry(state, record, record.ttlMs)
  }

  release(leaseId: string): void {
    const found = this.find(leaseId)
    if (!found) return
    const { state, record } = found
    if (record.timer) clearTimeout(record.timer)
    if (record.scope === 'workspace') {
      if (state.workspaceLease?.leaseId === leaseId) state.workspaceLease = undefined
    } else {
      state.paths.delete(record.key)
    }
    this.drain(state)
  }

  snapshot(workspaceId?: string): WorkspaceLeaseSnapshot[] {
    const out: WorkspaceLeaseSnapshot[] = []
    for (const state of this.states.values()) {
      if (workspaceId && state.workspaceId !== workspaceId) continue
      const records = [
        ...state.paths.values(),
        ...(state.workspaceLease ? [state.workspaceLease] : []),
      ]
      for (const record of records) {
        out.push({
          leaseId: record.leaseId,
          workspaceId: record.workspaceId,
          scope: record.scope,
          ...(record.target ? { target: record.target } : {}),
          sessionId: record.sessionId,
          toolCallId: record.toolCallId,
          acquiredAt: record.acquiredAt,
          expiresAt: record.expiresAt,
        })
      }
    }
    return out
  }

  dispose(): void {
    const error = new Error('workspace lease manager disposed')
    for (const state of this.states.values()) {
      for (const waiter of state.waiters.splice(0)) {
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.onAbort) {
          waiter.signal?.removeEventListener('abort', waiter.onAbort)
          waiter.onAbort = undefined
        }
        waiter.reject(error)
      }
      for (const record of state.paths.values()) {
        if (record.timer) clearTimeout(record.timer)
      }
      if (state.workspaceLease?.timer) clearTimeout(state.workspaceLease.timer)
    }
    this.states.clear()
  }

  private stateFor(workspaceId: string): WorkspaceState {
    let state = this.states.get(workspaceId)
    if (!state) {
      state = { workspaceId, paths: new Map(), waiters: [] }
      this.states.set(workspaceId, state)
    }
    return state
  }

  private canAcquire(state: WorkspaceState, scope: LeaseScope, key: string): boolean {
    if (state.workspaceLease) return false
    if (scope === 'workspace') return state.paths.size === 0
    return !state.paths.has(key)
  }

  private grant(
    state: WorkspaceState,
    request: LeaseRequest,
    key: string,
    target: string | undefined,
    ttlMs: number,
  ): WorkspaceLeaseHandle {
    const record: LeaseRecord = {
      leaseId: `lease-${randomUUID()}`,
      workspaceId: request.workspaceId,
      scope: request.scope,
      ...(target ? { target } : {}),
      key,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      ttlMs,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }
    if (record.scope === 'workspace') state.workspaceLease = record
    else state.paths.set(record.key, record)
    this.scheduleExpiry(state, record, ttlMs)
    return leaseHandle(this, record)
  }

  private scheduleExpiry(state: WorkspaceState, record: LeaseRecord, ttlMs: number): void {
    if (record.timer) clearTimeout(record.timer)
    record.timer = setTimeout(() => this.expire(record.leaseId), ttlMs)
    record.timer.unref?.()
  }

  private expire(leaseId: string): void {
    const found = this.find(leaseId)
    if (!found) return
    const { state, record } = found
    if (record.scope === 'workspace') {
      if (state.workspaceLease?.leaseId === leaseId) state.workspaceLease = undefined
    } else {
      state.paths.delete(record.key)
    }
    this.drain(state)
  }

  private drain(state: WorkspaceState): void {
    while (state.waiters.length > 0) {
      const waiter = state.waiters[0]!
      if (!this.canAcquire(state, waiter.scope, waiter.key)) break
      state.waiters.shift()
      if (waiter.timer) clearTimeout(waiter.timer)
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.onAbort = undefined
      }
      waiter.resolve(this.grant(
        state,
        {
          workspaceId: waiter.workspaceId,
          scope: waiter.scope,
          ...(waiter.target ? { target: waiter.target } : {}),
          sessionId: waiter.sessionId,
          toolCallId: waiter.toolCallId,
        },
        waiter.key,
        waiter.target,
        waiter.ttlMs,
      ))
    }
  }

  private find(leaseId: string): { state: WorkspaceState; record: LeaseRecord } | undefined {
    for (const state of this.states.values()) {
      if (state.workspaceLease?.leaseId === leaseId) {
        return { state, record: state.workspaceLease }
      }
      for (const record of state.paths.values()) {
        if (record.leaseId === leaseId) return { state, record }
      }
    }
    return undefined
  }
}
