/**
 * fetch：HTTP 请求。文本按 UTF-8 解码，二进制只给摘要与字节数。
 *
 * @module if/tools/builtin/fetch
 */

import type { ToolDefinition } from '../types.ts'

export const fetchTool: ToolDefinition = {
  name: 'fetch',
  description: '发起 HTTP 请求。适合拉取网页、API、文本；二进制只返回摘要。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', description: '默认 GET' },
      headers: { type: 'object' },
      body: { type: 'string' },
      timeoutMs: { type: 'number' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  meta: { readOnly: true },

  async run(args, context) {
    const input = args as {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
    }

    const response = await fetch(input.url, {
      method: input.method ?? 'GET',
      headers: input.headers,
      body: input.body,
      signal: context.signal,
    })

    const buffer = Buffer.from(await response.arrayBuffer())
    const mime = response.headers.get('content-type') ?? 'application/octet-stream'
    const textual =
      mime.startsWith('text/') ||
      mime.includes('json') ||
      mime.includes('xml') ||
      mime.includes('javascript')

    return {
      text: textual
        ? new TextDecoder('utf-8').decode(buffer)
        : `[binary ${buffer.length} bytes, ${mime}]`,
      structured: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
      bytes: buffer.length,
      encoding: textual ? 'utf-8' : 'binary',
      mime,
      isError: !response.ok,
    }
  },
}
