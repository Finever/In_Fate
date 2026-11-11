/**
 * 摘要后台队列：写入/修改后各自排队，不占用对话会话。
 *
 * 同一个 target 只排一次；生成前比对 sourceDigest，内容没变直接 skipped。
 * 模型调用串行，避免一次记忆写入打出几十个并发请求。
 *
 * @module if/memory/summary-worker
 */

import type { MemorySummaryStore } from './summary.ts'

export type SummaryJobStatus = 'queued' | 'running' | 'done' | 'skipped' | 'error' | 'unavailable'

export interface SummaryJobView {
  readonly target: string
  readonly status: SummaryJobStatus
  readonly error?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

export interface SummaryWorkerStatus {
  readonly generator: boolean
  readonly running: boolean
  readonly queued: number
  readonly jobs: readonly SummaryJobView[]
  readonly lastError?: string
}

interface Job extends SummaryJobView {
  readonly key: string
}

export interface MemorySummaryWorkerOptions {
  readonly summaries: MemorySummaryStore
  readonly onStatus?: (status: SummaryWorkerStatus) => void
}

export class MemorySummaryWorker {
  private readonly summaries: MemorySummaryStore
  private readonly onStatus?: (status: SummaryWorkerStatus) => void
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private readonly jobs = new Map<string, Job>()
  private running = false
  private stopped = false
  private lastError?: string
  private timer?: NodeJS.Timeout

  constructor(options: MemorySummaryWorkerOptions) {
    this.summaries = options.summaries
    this.onStatus = options.onStatus
  }

  get canGenerate(): boolean {
    return this.summaries.hasGenerator()
  }

  /** 写入/修改后调用；unchanged 的内容会进 skipped，不会调用模型。 */
  enqueue(target: string, options: { readonly force?: boolean } = {}): boolean {
    if (this.stopped || !this.canGenerate) return false
    if (this.queued.has(target)) return false
    if (!options.force) {
      try {
        if (!this.summaries.needsUpdate(target)) {
          this.setJob(target, 'skipped')
          return false
        }
      } catch {
        // 读不了 detail 时交给后面的错误路径。
      }
    }
    this.queue.push(target)
    this.queued.add(target)
    this.setJob(target, 'queued')
    void this.pump()
    return true
  }

  enqueueAll(options: { readonly force?: boolean } = {}): number {
    if (this.stopped || !this.canGenerate) return 0
    const files = this.summaries.store.listDocuments({
      includePrivate: false,
      includeInvalid: false,
    })
    this.summaries.prune(new Set(files.map(file => file.target)))
    let count = 0
    for (const file of files) {
      if (this.enqueue(file.target, options)) count += 1
    }
    return count
  }

  status(): SummaryWorkerStatus {
    return {
      generator: this.canGenerate,
      running: this.running,
      queued: this.queue.length,
      jobs: [...this.jobs.values()]
        .sort((a, b) => (b.finishedAt ?? b.startedAt ?? '').localeCompare(a.finishedAt ?? a.startedAt ?? ''))
        .slice(0, 100)
        .map(({ key: _key, ...job }) => job),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  async waitIdle(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** 周期扫描外部编辑；没有生成器时什么都不做。 */
  start(intervalMs = 30_000): void {
    if (this.timer || !this.canGenerate) return
    this.timer = setInterval(() => this.enqueueAll(), Math.max(1_000, intervalMs))
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.queue.length = 0
    this.queued.clear()
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (!this.stopped && this.queue.length > 0) {
        const target = this.queue.shift()!
        this.queued.delete(target)
        if (!this.canGenerate) {
          this.setJob(target, 'unavailable')
          continue
        }
        let needsUpdate = true
        try {
          needsUpdate = this.summaries.needsUpdate(target)
        } catch (error) {
          this.setJob(target, 'error', error)
          continue
        }
        if (!needsUpdate) {
          this.setJob(target, 'skipped')
          continue
        }
        this.setJob(target, 'running', undefined, new Date().toISOString())
        try {
          await this.summaries.generate(target)
          this.lastError = undefined
          this.setJob(target, 'done', undefined, undefined, new Date().toISOString())
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.lastError = message
          this.setJob(target, 'error', error, undefined, new Date().toISOString())
        }
      }
    } finally {
      this.running = false
      this.onStatus?.(this.status())
    }
  }

  private setJob(
    target: string,
    status: SummaryJobStatus,
    error?: unknown,
    startedAt?: string,
    finishedAt?: string,
  ): void {
    const previous = this.jobs.get(target)
    this.jobs.set(target, {
      key: target,
      target,
      status,
      ...(previous?.startedAt && !startedAt ? { startedAt: previous.startedAt } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(error
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
      ...(status === 'done' || status === 'error' || status === 'skipped' || status === 'unavailable'
        ? { finishedAt: finishedAt ?? new Date().toISOString() }
        : {}),
    })
    this.onStatus?.(this.status())
  }
}
