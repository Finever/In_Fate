import { BlobStore, type ContentRef } from '../core/blobs.ts'
import type { ToolResult } from './types.ts'

export interface OffloadConfig {
  readonly enabled: boolean
  readonly maxInlineBytes: number
  readonly maxStructuredBytes: number
  readonly previewHeadChars: number
  readonly previewTailChars: number
}

export const DEFAULT_OFFLOAD: OffloadConfig = {
  enabled: true,
  maxInlineBytes: 32 * 1024,
  maxStructuredBytes: 32 * 1024,
  previewHeadChars: 1200,
  previewTailChars: 400,
}

function clip(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text
  let head = text.slice(0, headChars)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  let tail = text.slice(-tailChars)
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
  return `${head}\n…\n${tail}`
}

function noticeOf(ref: ContentRef, bytes: number): string {
  return `\n…[offloaded ${bytes} bytes; ref ${ref.ref}; use recall with this ref to read]`
}

export class OffloadPolicy {
  readonly blobs: BlobStore
  readonly config: OffloadConfig

  constructor(blobs: BlobStore, config: OffloadConfig = DEFAULT_OFFLOAD) {
    this.blobs = blobs
    this.config = config
  }

  apply(result: ToolResult): ToolResult {
    if (!this.config.enabled) return result

    let out: ToolResult = result
    const text = result.text ?? ''
    const textBytes = Buffer.byteLength(text, 'utf8')

    if (text.length > 0 && textBytes > this.config.maxInlineBytes) {
      const preview = clip(text, this.config.previewHeadChars, this.config.previewTailChars)
      try {
        const blob = this.blobs.put(text, {
          kind: 'text',
          ...(result.mime ? { mime: result.mime } : {}),
          // blob 里存的是解码后的 UTF-8 文本；原始编码留在事件 payload.encoding。
          encoding: 'utf-8',
        })
        const contentRef: ContentRef = {
          ...blob,
          fields: ['text'],
          previewBytes: Buffer.byteLength(preview, 'utf8'),
        }
        const nextText = preview + noticeOf(contentRef, textBytes)
        // 原文太小时，通知本身可能比原文还长；这种就不卸。
        out = Buffer.byteLength(nextText, 'utf8') < textBytes
          ? { ...out, text: nextText, contentRef }
          : out
      } catch (error) {
        out = {
          ...out,
          offloadError: `text offload failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    if (result.structured !== undefined) {
      const json = JSON.stringify(result.structured)
      if (Buffer.byteLength(json, 'utf8') > this.config.maxStructuredBytes) {
        try {
          const blob = this.blobs.put(json, {
            kind: 'text',
            mime: 'application/json',
            encoding: 'utf-8',
          })
          const structuredRef: ContentRef = {
            ...blob,
            fields: ['structured'],
            previewBytes: 0,
          }
          out = {
            ...out,
            structured: undefined,
            structuredRef,
          }
        } catch (error) {
          out = {
            ...out,
            offloadError: `structured offload failed: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
    }

    return out
  }
}
