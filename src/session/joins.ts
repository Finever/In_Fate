/**
 * 会话 join：等待一组目标会话完成，不占模型槽位。
 *
 * join 事件写在等待方自己的流里；目标完成后由调度器检查 all/any，
 * 满足时追加 join.done 与一条 system 注入，再唤醒等待方新一轮。
 *
 * @module if/session/joins
 */

import { randomUUID } from 'node:crypto'
import type { Event } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import { sessionStream } from '../core/streams.ts'

export type JoinMode = 'all' | 'any'
export type JoinStatus = 'pending' | 'done' | 'timeout' | 'cancelled'

export interface SessionJoinInput {
  readonly sessionId: string
  readonly targets: readonly string[]
  readonly mode?: JoinMode
  readonly timeoutMs?: number
}

export interface SessionJoinRecord {
  readonly joinId: string
  readonly sessionId: string
  readonly targets: readonly string[]
  readonly mode: JoinMode
  readonly timeoutMs: number
  readonly createdAt: string
  status: JoinStatus
  readonly satisfied: Set<string>
}

export interface SessionJoinSnapshot {
  readonly joinId: string
  readonly sessionId: string
  readonly targets: readonly string[]
  readonly mode: JoinMode
  readonly timeoutMs: number
  readonly createdAt: string
  readonly status: JoinStatus
  readonly satisfied: readonly string[]
}

export function snapshotJoin(record: SessionJoinRecord): SessionJoinSnapshot {
  return { ...record, satisfied: [...record.satisfied] }
}

export interface JoinSchedulerDeps {
  readonly storeFor: (sessionId: string) => EventStore
  readonly writerFor: (sessionId: string) => SessionWriter
  /** 目标当前是否还在跑；idle/done 视为已满足 */
  readonly isRunning: (sessionId: string) => boolean
  /** 等待方是否有权关联目标 */
  readonly linked: (from: string, to: string) => boolean
  /** 唤醒等待方；由宿主负责排队和 skipStartEvent */
  readonly wake: (sessionId: string) => void
  readonly now?: () => Date
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

function joinEvent(record: SessionJoinRecord): Event['payload'] {
  return {
    joinId: record.joinId,
    sessionId: record.sessionId,
    targets: record.targets,
    mode: record.mode,
    timeoutMs: record.timeoutMs,
    createdAt: record.createdAt,
  }
}

export class SessionJoinScheduler {
  private readonly deps: JoinSchedulerDeps
  private readonly records = new Map<string, SessionJoinRecord>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(deps: JoinSchedulerDeps) {
    this.deps = deps
  }

  create(input: SessionJoinInput): SessionJoinRecord {
    const targets = [...new Set(input.targets)]
      .filter(target => target.length > 0)
    if (targets.length === 0) throw new Error('join needs at least one target')
    if (targets.includes(input.sessionId)) throw new Error('join cannot target itself')
    for (const target of targets) {
      if (!this.deps.linked(input.sessionId, target)) {
        throw new Error(`join target is not linked: ${target}`)
      }
    }

    const mode = input.mode ?? 'all'
    if (mode !== 'all' && mode !== 'any') throw new Error(`unknown join mode: ${mode}`)
    const timeoutMs = Math.max(
      1,
      Math.min(MAX_TIMEOUT_MS, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    )
    const createdAt = (this.deps.now?.() ?? new Date()).toISOString()
    const record: SessionJoinRecord = {
      joinId: `join-${randomUUID()}`,
      sessionId: input.sessionId,
      targets,
      mode,
      timeoutMs,
      createdAt,
      status: 'pending',
      satisfied: new Set(),
    }

    const writer = this.deps.writerFor(input.sessionId)
    writer.append({
      stream: sessionStream(input.sessionId),
      actor: 'system',
      type: 'session.join',
      refs: { session: input.sessionId },
      payload: joinEvent(record),
    })
    writer.flush()

    this.records.set(record.joinId, record)
    for (const target of targets) {
      if (!this.deps.isRunning(target)) record.satisfied.add(target)
    }
    this.scheduleTimeout(record)
    // create 发生在当前 turn 里；若目标已经空闲，join 立即满足，
    // 但不能再唤醒一轮，否则当前 turn 和唤醒轮会重复。
    this.maybeComplete(record, false)
    return record
  }

  /** 目标完成一轮；waiting 不算完成，避免把还在等别人的目标当成 done。 */
  onTurnCompleted(sessionId: string, status: string): void {
    if (status === 'waiting') return
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue
      if (!record.targets.includes(sessionId)) continue
      record.satisfied.add(sessionId)
      this.maybeComplete(record)
    }
  }

  cancel(sessionId: string, joinId?: string): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.sessionId !== sessionId || record.status !== 'pending') continue
      if (joinId && record.joinId !== joinId) continue
      this.finish(record, 'cancelled')
      count += 1
    }
    return count
  }

  pending(sessionId?: string): SessionJoinRecord[] {
    return [...this.records.values()].filter(record =>
      record.status === 'pending' && (!sessionId || record.sessionId === sessionId))
  }

  /**
   * 从会话流恢复未完成的 join。目标在重载后可能已经完成，直接按当前状态重算。
   */
  restore(sessionId: string): void {
    const events = this.deps.storeFor(sessionId).read()
    const terminal = new Set<string>()
    for (const event of events) {
      if (
        event.type === 'session.join.done'
        || event.type === 'session.join.timeout'
        || event.type === 'session.join.cancelled'
      ) {
        const joinId = event.payload.joinId
        if (typeof joinId === 'string') terminal.add(joinId)
      }
    }

    for (const event of events) {
      if (event.type !== 'session.join') continue
      const payload = event.payload as {
        joinId?: unknown
        targets?: unknown
        mode?: unknown
        timeoutMs?: unknown
        createdAt?: unknown
      }
      if (typeof payload.joinId !== 'string' || terminal.has(payload.joinId)) continue
      if (this.records.has(payload.joinId)) continue
      if (!Array.isArray(payload.targets)) continue
      const targets = payload.targets.filter((item): item is string => typeof item === 'string')
      if (targets.length === 0) continue
      const mode = payload.mode === 'any' ? 'any' : 'all'
      const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : DEFAULT_TIMEOUT_MS
      const createdAt = typeof payload.createdAt === 'string' ? payload.createdAt : event.ts
      const record: SessionJoinRecord = {
        joinId: payload.joinId,
        sessionId,
        targets,
        mode,
        timeoutMs,
        createdAt,
        status: 'pending',
        satisfied: new Set(),
      }
      this.records.set(record.joinId, record)
      for (const target of targets) {
        if (!this.deps.isRunning(target)) record.satisfied.add(target)
      }
      this.scheduleTimeout(record)
      this.maybeComplete(record)
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.records.clear()
  }

  private maybeComplete(record: SessionJoinRecord, wake = true): void {
    if (record.status !== 'pending') return
    const done = record.mode === 'any'
      ? record.satisfied.size > 0
      : record.targets.every(target => record.satisfied.has(target))
    if (done) this.finish(record, 'done', wake)
  }

  private scheduleTimeout(record: SessionJoinRecord): void {
    const now = this.deps.now?.() ?? new Date()
    const deadline = new Date(record.createdAt).getTime() + record.timeoutMs
    const delay = Math.max(1, deadline - now.getTime())
    const timer = setTimeout(() => this.finish(record, 'timeout'), delay)
    timer.unref?.()
    this.timers.set(record.joinId, timer)
  }

  private finish(
    record: SessionJoinRecord,
    status: Exclude<JoinStatus, 'pending'>,
    wake = true,
  ): void {
    if (record.status !== 'pending') return
    record.status = status
    const timer = this.timers.get(record.joinId)
    if (timer) clearTimeout(timer)
    this.timers.delete(record.joinId)

    const writer = this.deps.writerFor(record.sessionId)
    const type = status === 'done'
      ? 'session.join.done'
      : status === 'timeout'
        ? 'session.join.timeout'
        : 'session.join.cancelled'
    writer.append({
      stream: sessionStream(record.sessionId),
      actor: 'system',
      type,
      refs: { session: record.sessionId, join: record.joinId },
      payload: {
        ...joinEvent(record),
        status,
        satisfied: [...record.satisfied],
        finishedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      },
    })

    if (status !== 'cancelled') {
      const targets = record.targets.join(', ')
      const notice = status === 'done'
        ? `[join] ${record.mode} 等待已满足：${targets}。继续当前任务。`
        : `[join] 等待超时：${targets}。按现有结果继续，或说明还缺什么。`
      writer.append({
        stream: sessionStream(record.sessionId),
        actor: 'system',
        type: 'message.system',
        refs: { join: record.joinId },
        payload: { text: notice, mark: 'injection' },
      })
      writer.flush()
      if (wake) this.deps.wake(record.sessionId)
    } else {
      writer.flush()
    }
    this.records.delete(record.joinId)
  }
}
