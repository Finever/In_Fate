import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { writeIndex } from './index.ts'

const exec = promisify(execFile)

export interface MemoryCommitterOptions {
  readonly enabled?: boolean
  readonly debounceMs?: number
  readonly onError?: (error: unknown) => void
}

export interface MemoryCommitStatus {
  readonly gitRoot?: string
  readonly enabled: boolean
  readonly dirty: readonly string[]
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

  /** 记忆库的 git 根：优先 memory root，其次 detail（现有库的常见布局）。 */
  private gitRoot(): string | undefined {
    if (existsSync(join(this.root, '.git'))) return this.root
    const detail = join(this.root, 'detail')
    if (existsSync(join(detail, '.git'))) return detail
    return undefined
  }

  markDirty(target: string): void {
    // 即使自动提交关着，也要记住待提交路径，供设置页手动提交。
    const gitRoot = this.gitRoot()
    if (!gitRoot) return
    // detail 子仓库只能收 detail 的变更；其它区不假装已纳入 git。
    if (gitRoot !== this.root && target !== 'detail' && !target.startsWith('detail:')) return
    this.dirty.add(target)
    if (!this.enabled) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(error => this.onError?.(error))
    }, this.debounceMs)
    this.timer.unref?.()
  }

  status(): MemoryCommitStatus {
    return {
      ...(this.gitRoot() ? { gitRoot: this.gitRoot()! } : {}),
      enabled: this.enabled,
      dirty: [...this.dirty].sort(),
    }
  }

  /** 设置页按钮用：不管 autoCommit 开关，强制提交当前 dirty。 */
  async commitNow(): Promise<void> {
    await this.flush(true)
  }

  async flush(force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.running) {
      await this.running
      if (this.dirty.size === 0) return
    }
    const gitRoot = this.gitRoot()
    if ((!this.enabled && !force) || this.dirty.size === 0 || !gitRoot) {
      if (!force) this.dirty.clear()
      return
    }

    const targets = [...this.dirty].sort()
    this.dirty.clear()
    this.running = (async () => {
      try {
        try {
          writeIndex({ memoryRoot: this.root })
        } catch (error) {
          this.onError?.(error)
        }
        const paths = gitRoot === this.root
          ? ['detail', 'proposals', 'summaries', 'agents', 'policy.json', 'README.md', '_设计草案.md']
            .filter(path => existsSync(join(this.root, path)))
          : ['.']
        await exec('git', ['-C', gitRoot, 'add', '--', ...paths], {
          windowsHide: true,
        })
        await exec('git', [
          '-C', gitRoot,
          'commit',
          '-m',
          `memory: ${force ? '手动' : '自动'}提交 ${targets.slice(0, 6).join(', ')}${targets.length > 6 ? '…' : ''}`,
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
