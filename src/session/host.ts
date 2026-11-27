interface QueueEntry {
  readonly run: () => Promise<void>
  readonly cancel: (error: Error) => void
}

interface HostState {
  active: boolean
  readonly queue: QueueEntry[]
}

export class SessionHost {
  private readonly states = new Map<string, HostState>()

  run<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const state = this.stateFor(sessionId)

    return new Promise<T>((resolve, reject) => {
      const task: QueueEntry = {
        run: async () => {
          try {
            resolve(await job())
          } catch (error) {
            reject(error)
          }
        },
        cancel: error => reject(error),
      }

      if (state.active) {
        state.queue.push(task)
        return
      }

      state.active = true
      void this.drain(sessionId, state, task)
    })
  }

  isActive(sessionId: string): boolean {
    return this.states.get(sessionId)?.active ?? false
  }

  activeCount(): number {
    let count = 0
    for (const state of this.states.values()) if (state.active) count += 1
    return count
  }

  queuedCount(): number {
    let count = 0
    for (const state of this.states.values()) count += state.queue.length
    return count
  }

  /** 拒绝还没开始的任务；active 任务由它自己的 AbortSignal 处理。 */
  dispose(): void {
    const error = new Error('session host disposed')
    for (const state of this.states.values()) {
      for (const entry of state.queue.splice(0)) entry.cancel(error)
    }
  }

  private stateFor(sessionId: string): HostState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { active: false, queue: [] }
      this.states.set(sessionId, state)
    }
    return state
  }

  private async drain(sessionId: string, state: HostState, first: QueueEntry): Promise<void> {
    let current: QueueEntry | undefined = first
    while (current) {
      await current.run()
      current = state.queue.shift()
    }
    state.active = false
    // drain 是单线程串行的；如果 await 期间又被 run 插入，queue 不会空。
    if (state.queue.length > 0) {
      const next = state.queue.shift()
      if (next) {
        state.active = true
        void this.drain(sessionId, state, next)
      }
    }
  }
}
