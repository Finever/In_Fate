import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertWithin, spillHash } from '../core/safe-path.ts'

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
    const hash = spillHash(ref)
    const file = assertWithin(this.root, join(this.root, `${hash}.txt`), 'spill ref')
    return readFileSync(file, 'utf8')
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
