/**
 * 记忆提交器：写文件可以并行，git 提交走一个全局队列。
 *
 * 只在 memory root 是 git 仓库时生效；没有 .git 就静默跳过。
 *
 * @module if/memory/committer
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface MemoryCommitterOptions {
  readonly enabled?: boolean
  readonly debounceMs?: number
  readonly onError?: (error: unknown) => void
}

export class MemoryCommitter {
  readonly root: string
  private readonly enabled: boolean
  private readonly debounceMs: number
  private readonly onError?: (error: unknown) => void
  private readonly dirty = new Set<string>()
  private timer?: NodeJS.Timeout
  private running?: Promise<void>

  constructor(root: string, options: MemoryCommitterOptions = {}) {
    this.root = root
    this.enabled = options.enabled ?? true
    this.debounceMs = Math.max(0, options.debounceMs ?? 800)
    if (options.onError) this.onError = options.onError
  }

  markDirty(target: string): void {
    if (!this.enabled || !existsSync(join(this.root, '.git'))) return
    this.dirty.add(target)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(error => this.onError?.(error))
    }, this.debounceMs)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.running) {
      await this.running
      if (this.dirty.size === 0) return
    }
    if (!this.enabled || this.dirty.size === 0 || !existsSync(join(this.root, '.git'))) {
      this.dirty.clear()
      return
    }

    const targets = [...this.dirty].sort()
    this.dirty.clear()
    this.running = (async () => {
      try {
        const paths = ['detail']
        if (existsSync(join(this.root, 'proposals'))) paths.push('proposals')
        await exec('git', ['-C', this.root, 'add', '--', ...paths], {
          windowsHide: true,
        })
        await exec('git', [
          '-C', this.root,
          'commit',
          '-m',
          `memory: 自动提交 ${targets.slice(0, 6).join(', ')}${targets.length > 6 ? '…' : ''}`,
        ], { windowsHide: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 没有可提交内容不是错误。
        if (!/nothing to commit|no changes added|working tree clean/i.test(message)) {
          this.onError?.(error)
          throw error
        }
      }
    })()

    try {
      await this.running
    } finally {
      this.running = undefined
    }
  }
}
