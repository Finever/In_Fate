/**
 * 内容寻址 blob 库。
 *
 * 事件只存预览 + ref；全文按 SHA-256 存在本地。写入顺序是
 * “先 blob 后事件”，读时 ref 只接受固定形状，拼路径后再断言在根内。
 *
 * @module if/core/blobs
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { assertWithin } from './safe-path.ts'

export type BlobKind = 'text' | 'binary'

export interface BlobRef {
  readonly ref: string
  readonly sha256: string
  readonly bytes: number
  readonly kind: BlobKind
  readonly mime?: string
  readonly encoding?: string
}

export interface ContentRef extends BlobRef {
  readonly fields: readonly ('text' | 'structured')[]
  readonly previewBytes?: number
}

export interface BlobPutOptions {
  readonly mime?: string
  readonly encoding?: string
  readonly kind?: BlobKind
}

export interface BlobTextSlice {
  readonly text: string
  readonly offset: number
  readonly totalChars: number
  readonly eof: boolean
  readonly bytes: number
}

export class BlobError extends Error {
  readonly code: 'BLOB_INVALID' | 'BLOB_MISSING' | 'BLOB_CORRUPT'

  constructor(code: BlobError['code'], message: string) {
    super(message)
    this.name = 'BlobError'
    this.code = code
  }
}

const REF_PATTERN = /^blob:([0-9a-f]{64})$/

function hashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function safeTextSlice(text: string, offset: number, limit: number): string {
  let start = Math.max(0, Math.min(text.length, Math.floor(offset)))
  let end = Math.max(start, Math.min(text.length, start + Math.max(0, Math.floor(limit))))
  // 不切在代理项中间
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start -= 1
  if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1
  return text.slice(start, end)
}

export class BlobStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  put(data: string | Buffer, options: BlobPutOptions = {}): BlobRef {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const sha256 = hashOf(buffer)
    const file = this.fileOf(sha256)
    const ref = `blob:${sha256}`

    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      const fd = openSync(temp, 'wx')
      try {
        writeSync(fd, buffer)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      try {
        renameSync(temp, file)
      } catch (error) {
        if (existsSync(file)) {
          try {
            unlinkSync(temp)
          } catch {
            // 目标已存在，忽略临时清理失败
          }
        } else {
          throw error
        }
      }
    }

    return {
      ref,
      sha256,
      bytes: buffer.length,
      kind: options.kind ?? 'text',
      ...(options.mime ? { mime: options.mime } : {}),
      ...(options.encoding ? { encoding: options.encoding } : {}),
    }
  }

  getBytes(ref: string): Buffer {
    const file = this.fileOf(this.hashOfRef(ref))
    if (!existsSync(file)) throw new BlobError('BLOB_MISSING', `blob missing: ${ref}`)
    return readFileSync(file)
  }

  readText(
    ref: string,
    options: { offset?: number; limit?: number; encoding?: string } = {},
  ): BlobTextSlice {
    const buffer = this.getBytes(ref)
    const text = new TextDecoder(options.encoding ?? 'utf-8').decode(buffer)
    const offset = Math.max(0, Math.min(text.length, Math.floor(options.offset ?? 0)))
    const limit = Math.max(0, Math.floor(options.limit ?? 20_000))
    const slice = safeTextSlice(text, offset, limit)
    return {
      text: slice,
      offset,
      totalChars: text.length,
      eof: offset + slice.length >= text.length,
      bytes: Buffer.byteLength(slice, 'utf8'),
    }
  }

  stat(ref: string): { bytes: number; path: string } {
    const file = this.fileOf(this.hashOfRef(ref))
    if (!existsSync(file)) throw new BlobError('BLOB_MISSING', `blob missing: ${ref}`)
    return { bytes: statSync(file).size, path: file }
  }

  verify(ref: string): boolean {
    try {
      const buffer = this.getBytes(ref)
      return hashOf(buffer) === this.hashOfRef(ref)
    } catch {
      return false
    }
  }

  pathOf(ref: string): string {
    return this.fileOf(this.hashOfRef(ref))
  }

  private hashOfRef(ref: string): string {
    const match = REF_PATTERN.exec(ref)
    if (!match) throw new BlobError('BLOB_INVALID', `invalid blob ref: ${ref}`)
    return match[1]!
  }

  private fileOf(hash: string): string {
    const file = join(this.root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.bin`)
    return assertWithin(this.root, file, 'blob ref')
  }
}
