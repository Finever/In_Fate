import type { HistoryMessage } from '../projections/history.ts'
import type { ChatRequest } from './chat.ts'
import { fallbackCallId, textOf } from './chat.ts'
import { postSSE } from './http-sse.ts'
import type { ResolvedModel } from './registry.ts'
import { runModelRequest } from './runtime.ts'
import type { ModelEvent, ToolSpec } from './types.ts'

export type { ChatRequest } from './chat.ts'

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

function requestBody(request: ChatRequest): Record<string, unknown> {
  const { resolved } = request
  const prefill = resolved.endpoint.supportsAssistantPrefill
    ? request.assistantPrefill
    : undefined
  const messages: Record<string, unknown>[] = [
    { role: request.systemAsUser ? 'user' : 'system', content: request.system },
    ...toOpenAIMessages(request.messages, request.systemAsUser ?? false),
  ]
  if (prefill) messages.push({ role: 'assistant', content: prefill })
  return {
    model: resolved.apiModelId,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(prefill ? { continue_final_message: true } : {}),
    ...(request.tools?.length ? { tools: toOpenAITools(request.tools) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  }
}

function requestHeaders(
  resolved: ResolvedModel,
  apiKey: string | undefined,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(resolved.endpoint.headers ?? {}),
  }
}

/** 单次尝试：负责把 SSE 翻成 ModelEvent。 */
async function* chatAttempt(
  request: ChatRequest,
  apiKey: string | undefined,
  timeoutMs: number,
): AsyncGenerator<ModelEvent> {
  const { resolved } = request
  // Chat Completions 沿用旧约定：baseUrl 自带版本段（例如 …/v1）。
  const url = `${resolved.endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  let done = false

  for await (const message of postSSE({
    url,
    headers: requestHeaders(resolved, apiKey),
    body: requestBody(request),
    timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  })) {
    const data = message.data.trim()
    if (data === '[DONE]') {
      done = true
      break
    }
    if (data.length === 0) continue

    const json = JSON.parse(data) as {
      choices?: {
        delta?: {
          content?: string
          reasoning_content?: string
          reasoning?: string
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
        prompt_cache_hit_tokens?: number
        cache_read_input_tokens?: number
      }
      error?: { message?: string }
    }

    if (json.error?.message) throw new Error(`model error: ${json.error.message}`)

    const choice = json.choices?.[0]
    const delta = choice?.delta

    if (delta?.content) yield { type: 'text', text: String(delta.content) }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (reasoning) yield { type: 'reasoning', text: String(reasoning) }

    for (const call of delta?.tool_calls ?? []) {
      const entry = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' }
      if (call.id) entry.id = String(call.id)
      if (call.function?.name) entry.name = String(call.function.name)
      if (call.function?.arguments) entry.arguments += String(call.function.arguments)
      toolCalls.set(call.index, entry)
    }

    if (choice?.finish_reason) {
      for (const entry of toolCalls.values()) {
        yield {
          type: 'tool_call',
          id: entry.id || fallbackCallId('openai'),
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
        cacheRead: json.usage.prompt_tokens_details?.cached_tokens
          ?? json.usage.prompt_cache_hit_tokens
          ?? json.usage.cache_read_input_tokens,
      }
    }
  }

  if (!done) {
    // 有些兼容网关不发 [DONE]；收尾时把还没吐出的工具调用补上。
    for (const entry of toolCalls.values()) {
      yield {
        type: 'tool_call',
        id: entry.id || fallbackCallId('openai'),
        name: entry.name,
        arguments: entry.arguments,
      }
    }
  }

  yield { type: 'done' }
}

/** 流式对话。产出统一的 ModelEvent，不把厂商格式漏给上层。 */
export async function* chatOpenAI(request: ChatRequest): AsyncGenerator<ModelEvent> {
  yield* runModelRequest(request, chatAttempt)
}
