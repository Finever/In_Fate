/**
 * fetch：HTTP 请求。两个后端：
 *   - direct：进程内直连，任意 URL、二进制、内网都行（默认）
 *   - deepseek：DeepSeek Fetch API，服务端抓取并转文本，适合反爬页面
 *
 * @module if/tools/builtin/fetch
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts'

const DEFAULT_BASE = 'https://api.deepseek.com/v1/tools'

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
      backend: 'direct',
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
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

  const payload = (await response.json()) as { content?: string }
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
