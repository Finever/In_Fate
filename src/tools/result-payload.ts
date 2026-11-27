import type { ToolResult } from './types.ts'

export function toolResultPayload(callId: string, result: ToolResult): Record<string, unknown> {
  return {
    callId,
    text: result.text ?? '',
    isError: result.isError ?? false,
    ...(result.waiting ? { waiting: true } : {}),
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
