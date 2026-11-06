/**
 * embedding 下载任务：给 UI 轮询用，进程内状态即可。
 *
 * @module if/model/local/embedding-jobs
 */

import { randomUUID } from 'node:crypto'
import type { EmbeddingInstallProgress, LocalEmbeddingStore } from './embedding-store.ts'

export type EmbeddingJobStatus = 'running' | 'done' | 'error'

export interface EmbeddingInstallJob {
  readonly id: string
  readonly modelId: string
  readonly status: EmbeddingJobStatus
  readonly received: number
  readonly total: number
  readonly ratio: number
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt?: string
}

export class EmbeddingInstallJobs {
  private readonly store: LocalEmbeddingStore
  private readonly onChanged?: (modelId: string) => void
  private readonly jobs = new Map<string, EmbeddingInstallJob>()
  private readonly running = new Map<string, Promise<void>>()

  constructor(
    store: LocalEmbeddingStore,
    onChanged?: (modelId: string) => void,
  ) {
    this.store = store
    this.onChanged = onChanged
  }

  start(modelId: string, options: { mirror?: boolean } = {}): EmbeddingInstallJob {
    const id = randomUUID()
    const initial: EmbeddingInstallJob = {
      id,
      modelId,
      status: 'running',
      received: 0,
      total: 0,
      ratio: 0,
      startedAt: new Date().toISOString(),
    }
    this.jobs.set(id, initial)

    const task = this.store.install(modelId, {
      ...(options.mirror !== undefined ? { mirror: options.mirror } : {}),
      onProgress: (progress: EmbeddingInstallProgress) => {
        const current = this.jobs.get(id)
        if (!current || current.status !== 'running') return
        this.jobs.set(id, {
          ...current,
          received: progress.received,
          total: progress.total,
          ratio: progress.ratio,
        })
      },
    }).then(() => {
      const current = this.jobs.get(id)
      if (current?.status === 'running') {
        const active = this.store.list().find(item => item.active)
        if (!active) this.store.activate(modelId)
        this.onChanged?.(modelId)
      }
      const latest = this.jobs.get(id)!
      this.jobs.set(id, {
        ...latest,
        status: 'done',
        ratio: 1,
        finishedAt: new Date().toISOString(),
      })
    }).catch((error: unknown) => {
      const latest = this.jobs.get(id)!
      this.jobs.set(id, {
        ...latest,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      })
    }).finally(() => {
      this.running.delete(id)
    })
    this.running.set(id, task)
    return initial
  }

  get(id: string): EmbeddingInstallJob | undefined {
    return this.jobs.get(id)
  }

  async wait(id: string): Promise<EmbeddingInstallJob | undefined> {
    await this.running.get(id)
    return this.get(id)
  }
}
