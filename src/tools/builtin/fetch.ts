/**
 * fetch：HTTP 请求。两个后端：
 *   - direct：进程内直连，任意 URL、二进制、内网都行（默认）
 *   - deepseek：DeepSeek Fetch API，服务端抓取并转文本，适合反爬页面
 *
 * @module if/tools/builtin/fetch
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts'

const DEFAULT_BASE = 'https://api.deepseek.com/v1/tools'
/** 单次响应最多保留的字节；超过就截断，不把整个响应读进内存。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      if (total + value.length > maxBytes) {
        const remaining = maxBytes - total
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
        truncated = true
        await reader.cancel()
        break
      }

      total += value.length
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return { buffer: Buffer.concat(chunks), truncated }
}

interface FetchInput {
  readonly url: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly backend?: 'direct' | 'deepseek'
}

async function directFetch(input: FetchInput, context: ToolContext): Promise<ToolResult> {
  const response = await fetch(input.url, {
    method: input.method ?? 'GET',
    headers: input.headers,
    body: input.body,
    signal: context.signal,
  })

  const { buffer, truncated } = await readCapped(response, MAX_RESPONSE_BYTES)
  const mime = response.headers.get('content-type') ?? 'application/octet-stream'
  const textual =
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('javascript')
  const notice = truncated ? `\n…[response truncated at ${MAX_RESPONSE_BYTES} bytes]` : ''

  return {
    text: (textual
      ? new TextDecoder('utf-8').decode(buffer)
      : `[binary ${buffer.length} bytes, ${mime}]`) + notice,
    structured: {
      backend: 'direct',
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      ...(truncated ? { truncated: true, limitBytes: MAX_RESPONSE_BYTES } : {}),
    },
    bytes: buffer.length,
    encoding: textual ? 'utf-8' : 'binary',
    mime,
    isError: !response.ok,
  }
}

async function deepseekFetch(input: FetchInput, context: ToolContext): Promise<ToolResult> {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set')
  const base = (process.env.DEEPSEEK_WEB_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '')

  const response = await fetch(`${base}/fetch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ url: input.url }),
    signal: context.signal,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`deepseek fetch http ${response.status}: ${detail.slice(0, 300)}`)
  }

  const { buffer, truncated } = await readCapped(response, MAX_RESPONSE_BYTES)
  if (truncated) {
    throw new Error(`deepseek fetch response too large (> ${MAX_RESPONSE_BYTES} bytes)`)
  }
  const payload = JSON.parse(buffer.toString('utf8')) as { content?: string }
  const content = typeof payload.content === 'string' ? payload.content : ''

  return {
    text: content,
    structured: { backend: 'deepseek', url: input.url },
    bytes: Buffer.byteLength(content, 'utf8'),
    encoding: 'utf-8',
    mime: 'text/markdown',
  }
}

export const fetchTool: ToolDefinition = {
  name: 'fetch',
  description:
    '发起 HTTP 请求。默认直连；被反爬挡住时用 backend=deepseek（DeepSeek 抓取 API，按次计费）。'
    + '二进制只返回摘要。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', description: '默认 GET' },
      headers: { type: 'object' },
      body: { type: 'string' },
      backend: { type: 'string', enum: ['direct', 'deepseek'], description: '默认 direct' },
      timeoutMs: { type: 'number' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  meta: { readOnly: true },

  async run(args, context) {
    const input = args as FetchInput
    return input.backend === 'deepseek'
      ? deepseekFetch(input, context)
      : directFetch(input, context)
  },
}
