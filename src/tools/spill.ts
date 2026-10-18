/**
 * 大输出溢出：超过阈值就落文件，只把引用和预览给模型。
 *
 * 阈值与预览长度都可调；存储实现可换（本地文件、对象存储）。
 *
 * @module if/tools/spill
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SpillStore {
  put(text: string): string
  get(ref: string): string
}

export class FileSpillStore implements SpillStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  put(text: string): string {
    const hash = createHash('sha1').update(text, 'utf8').digest('hex')
    mkdirSync(this.root, { recursive: true })
    writeFileSync(join(this.root, `${hash}.txt`), text, 'utf8')
    return `spill:${hash}`
  }

  get(ref: string): string {
    const hash = ref.replace(/^spill:/, '')
    return readFileSync(join(this.root, `${hash}.txt`), 'utf8')
  }
}

export interface SpillResult {
  readonly text: string
  readonly ref?: string
  readonly bytes: number
}

export class SpillPolicy {
  readonly store: SpillStore
  readonly thresholdBytes: number
  readonly previewChars: number

  constructor(store: SpillStore, thresholdBytes = 64 * 1024, previewChars = 2000) {
    this.store = store
    this.thresholdBytes = thresholdBytes
    this.previewChars = previewChars
  }

  apply(text: string): SpillResult {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= this.thresholdBytes) return { text, bytes }

    const ref = this.store.put(text)
    const preview = text.slice(0, this.previewChars)
    return {
      text: `${preview}\n…[truncated, ${bytes} bytes at ${ref}]`,
      ref,
      bytes,
    }
  }
}
