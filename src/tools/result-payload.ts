/**
 * tool.result 事件的载荷：结果 envelope 里能落盘的字段都在这里。
 *
 * 投影只需要 text，但 bytes / encoding / ref 是后续卸载、UI 展开和
 * 回查的地址；少写一个，spill 出去的原文就找不回来。
 *
 * @module if/tools/result-payload
 */

import type { ToolResult } from './types.ts'

export function toolResultPayload(callId: string, result: ToolResult): Record<string, unknown> {
  return {
    callId,
    text: result.text ?? '',
    isError: result.isError ?? false,
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
    ...(result.mime ? { mime: result.mime } : {}),
    ...(result.ref ? { ref: result.ref } : {}),
    ...(result.contentRef ? { contentRef: result.contentRef } : {}),
    ...(result.structuredRef ? { structuredRef: result.structuredRef } : {}),
    ...(result.offloadError ? { offloadError: result.offloadError } : {}),
    ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
    ...(result.encoding ? { encoding: result.encoding } : {}),
    ...(result.requestedEncoding ? { requestedEncoding: result.requestedEncoding } : {}),
  }
}
