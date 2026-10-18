/**
 * OpenAI Chat Completions 适配器（流式）。
 *
 * 只依赖来源配置里的 baseUrl 与密钥，不认识任何具体厂商。
 * 内部消息 → OpenAI 消息在这里转换；tool_calls 的增量参数在这里拼完整。
 *
 * @module if/model/openai
 */

import type { HistoryMessage } from '../projections/history.ts'
import { resolveApiKey, type ResolvedModel } from './registry.ts'
import type { ModelEvent, ToolSpec } from './types.ts'

export interface ChatRequest {
  readonly resolved: ResolvedModel
  readonly system: string
  readonly messages: readonly HistoryMessage[]
  readonly tools?: readonly ToolSpec[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly signal?: AbortSignal
  /** system 角色的消息是否转成 user（部分来源不认 system）。默认 false。 */
  readonly systemAsUser?: boolean
}

function textOf(message: HistoryMessage): string {
  if (message.role === 'tool') return message.content
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toOpenAIMessages(
  messages: readonly HistoryMessage[],
  systemAsUser: boolean,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolUseId, content: message.content })
      continue
    }

    if (message.role === 'system') {
      out.push({ role: systemAsUser ? 'user' : 'system', content: textOf(message) })
      continue
    }

    if (message.role === 'user') {
      out.push({ role: 'user', content: textOf(message) })
      continue
    }

    const toolCalls = message.content
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }))

    const text = textOf(message)
    out.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }

  return out
}

function toOpenAITools(tools: readonly ToolSpec[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  }))
}

/** 流式对话。产出统一的 ModelEvent，不把厂商格式漏给上层。 */
export async function* chatOpenAI(request: ChatRequest): AsyncGenerator<ModelEvent> {
  const { resolved } = request
  const key = resolveApiKey(resolved.provider)
  const url = `${resolved.endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(resolved.endpoint.headers ?? {}),
  }

  const body: Record<string, unknown> = {
    model: resolved.apiModelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'system', content: request.system }, ...toOpenAIMessages(request.messages, request.systemAsUser ?? false)],
    ...(request.tools?.length ? { tools: toOpenAITools(request.tools) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`model http ${response.status}: ${text.slice(0, 500)}`)
  }
  if (!response.body) throw new Error('model response has no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  let done = false

  while (!done) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      for (const line of block.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          done = true
          break
        }

        const json = JSON.parse(data) as {
          choices?: {
            delta?: {
              content?: string
              reasoning_content?: string
              tool_calls?: {
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }[]
            }
            finish_reason?: string | null
          }[]
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
          }
        }

        const choice = json.choices?.[0]
        const delta = choice?.delta

        if (delta?.content) yield { type: 'text', text: String(delta.content) }
        if (delta?.reasoning_content) yield { type: 'reasoning', text: String(delta.reasoning_content) }

        for (const call of delta?.tool_calls ?? []) {
          const entry = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' }
          if (call.id) entry.id = String(call.id)
          if (call.function?.name) entry.name = String(call.function.name)
          if (call.function?.arguments) entry.arguments += String(call.function.arguments)
          toolCalls.set(call.index, entry)
        }

        if (choice?.finish_reason) {
          for (const [index, entry] of toolCalls) {
            yield {
              type: 'tool_call',
              id: entry.id || `call-${index}`,
              name: entry.name,
              arguments: entry.arguments,
            }
          }
          toolCalls.clear()
        }

        if (json.usage) {
          yield {
            type: 'usage',
            input: json.usage.prompt_tokens,
            output: json.usage.completion_tokens,
            cacheRead: json.usage.prompt_tokens_details?.cached_tokens,
          }
        }
      }

      if (done) break
      boundary = buffer.indexOf('\n\n')
    }
  }

  yield { type: 'done' }
}
