import type { ToolDefinition, ToolResult } from '../types.ts'

const DEFAULT_BASE = 'https://api.deepseek.com/v1/tools'

function baseUrl(): string {
  return (process.env.DEEPSEEK_WEB_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '')
}

function apiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set')
  return key
}

interface SearchResult {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}

export const websearchTool: ToolDefinition = {
  name: 'websearch',
  description:
    '用 DeepSeek 搜索网页，返回标题、链接和摘要。适合查资料、找最新信息；'
    + '要读正文用 fetch。按成功请求计费。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词' },
      count: { type: 'number', minimum: 1, maximum: 50, description: '返回条数，默认 10' },
      ori_question: { type: 'string', maxLength: 128, description: '触发这次搜索的原始问题，可选' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  meta: { readOnly: true },

  async run(args, context): Promise<ToolResult> {
    const input = args as { query: string; count?: number; ori_question?: string }

    const response = await fetch(`${baseUrl()}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        query: input.query,
        count: Math.min(input.count ?? 10, 50),
        need_content: false,
        ...(input.ori_question ? { ori_question: input.ori_question.slice(0, 128) } : {}),
      }),
      signal: context.signal,
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`deepseek search http ${response.status}: ${detail.slice(0, 300)}`)
    }

    const payload = (await response.json()) as { results?: SearchResult[] }
    const results = Array.isArray(payload.results) ? payload.results : []
    const text = results.length === 0
      ? '（无结果）'
      : results
          .map((item, index) => `${index + 1}. ${item.title ?? ''}\n   ${item.url}\n   ${item.snippet ?? ''}`)
          .join('\n\n')

    return {
      text,
      structured: { results },
      bytes: Buffer.byteLength(text, 'utf8'),
      encoding: 'utf-8',
      mime: 'application/json',
    }
  },
}
