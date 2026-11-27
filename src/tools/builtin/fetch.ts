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

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

function dropHeaders(
  headers: Record<string, string> | undefined,
  names: readonly string[],
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out = { ...headers }
  for (const name of Object.keys(out)) {
    if (names.includes(name.toLowerCase())) delete out[name]
  }
  return out
}

interface Fetched {
  readonly response: Response
  readonly url: URL
  readonly redirects: number
}

/**
 * 手动跟重定向：
 *   - 每一跳都重新过网络策略（防公网跳私网）
 *   - 跨 origin 丢掉 Authorization/Cookie
 *   - 301/302/303 把 POST 降成 GET；307/308 保留方法和正文
 */
async function fetchWithPolicy(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  context: ToolContext,
): Promise<Fetched> {
  const guard = context.network
  let current = guard ? await guard.check(url) : new URL(url)
  let method = init.method
  let headers = init.headers
  let body = init.body
  const maxRedirects = guard?.maxRedirects ?? 0

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current, {
      method,
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      signal: init.signal,
      ...(guard ? { redirect: 'manual' as const } : {}),
    })

    if (!guard || !REDIRECT_STATUS.has(response.status)) {
      return { response, url: current, redirects: hop }
    }

    const location = response.headers.get('location')
    if (!location) return { response, url: current, redirects: hop }
    if (hop === maxRedirects) {
      try {
        await response.body?.cancel()
      } catch {
        // 连接已关闭
      }
      throw new Error(`too many redirects (>${maxRedirects})`)
    }

    const next = new URL(location, current)
    try {
      await response.body?.cancel()
    } catch {
      // 连接已关闭
    }

    if (next.origin !== current.origin) headers = dropHeaders(headers, SENSITIVE_HEADERS)
    if (response.status === 303 || ((response.status === 301 || response.status === 302)
      && method.toUpperCase() === 'POST')) {
      method = 'GET'
      body = undefined
      headers = dropHeaders(headers, ['content-type', 'content-length'])
    }

    current = guard ? await guard.check(next.href) : next
  }

  throw new Error('too many redirects')
}

async function directFetch(input: FetchInput, context: ToolContext): Promise<ToolResult> {
  const fetched = await fetchWithPolicy(input.url, {
    method: input.method ?? 'GET',
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    signal: context.signal,
  }, context)
  const { response } = fetched

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
      url: fetched.url.href,
      redirects: fetched.redirects,
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
  // 抓取发生在服务端，本地不做 DNS 解析；仍拒绝非法协议与字面量私网地址。
  await context.network?.check(input.url, { resolve: false })
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
