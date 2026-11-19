/**
 * UI API 的返回形状与小工具。
 *
 * 这里不读文件；读事件/读 spill 由 app 层注入，保持可测试。
 *
 * @module if/ui/api
 */

export interface UiPayloadInput {
  /** spill/blob 引用 */
  readonly ref?: string
  /** 或直接取某条事件里的全文 */
  readonly eventId?: string
  /** 事件同时有 text/structured ref 时选哪个 */
  readonly field?: 'text' | 'structured'
  readonly offset?: number
  readonly limit?: number
}

export interface UiPayloadSlice {
  readonly data: string
  readonly offset: number
  readonly totalChars: number
  readonly eof: boolean
  readonly bytes: number
  readonly mime?: string
  readonly encoding?: string
}

export interface UiSessionStats {
  readonly sessionId: string
  readonly events: number
  readonly turns: number
  readonly compacted: number
  readonly pruned: number
  readonly lastSeq: number
  readonly asOfSeq?: number
  readonly fileBytes: number
  readonly segments: number
}

export interface UiApproval {
  readonly approvalId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  /** 风险守卫给出的具体原因；普通工具审批可省略。 */
  readonly reason?: string
}

export function slicePayload(
  text: string,
  offset = 0,
  limit = 20_000,
  meta: { mime?: string; encoding?: string } = {},
): UiPayloadSlice {
  const start = Math.max(0, Math.min(text.length, Math.floor(offset)))
  const size = Math.max(0, Math.floor(limit))
  const data = text.slice(start, start + size)
  const end = start + data.length
  return {
    data,
    offset: start,
    totalChars: text.length,
    eof: end >= text.length,
    bytes: Buffer.byteLength(data, 'utf8'),
    ...(meta.mime ? { mime: meta.mime } : {}),
    ...(meta.encoding ? { encoding: meta.encoding } : {}),
  }
}
