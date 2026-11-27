import type { HistoryMessage } from '../projections/history.ts'
import type { ChatRequest } from './chat.ts'
import { fallbackCallId, systemText, textOf } from './chat.ts'
import { postSSE } from './http-sse.ts'
import { runModelRequest } from './runtime.ts'
import type { ModelEvent, ToolSpec } from './types.ts'
import { apiUrl } from './urls.ts'

type Item = Record<string, unknown>

function toInputItems(messages: readonly HistoryMessage[]): Item[] {
  const out: Item[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      out.push({
        type: 'function_call_output',
        call_id: message.toolUseId,
        output: message.content,
      })
      continue
    }

    if (message.role === 'user') {
      const text = textOf(message)
      if (text.length > 0) {
        out.push({ role: 'user', content: [{ type: 'input_text', text }] })
      }
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue
        out.push({
          type: 'function_call_output',
          call_id: block.toolUseId,
          output: block.content,
        })
      }
      continue
    }

    const text = textOf(message)
    if (text.length > 0) {
      out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
    }
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      out.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      })
    }
  }

  return out
}

function toTools(tools: readonly ToolSpec[]): Item[] {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema,
  }))
}

function requestBody(request: ChatRequest): Item {
  const system = systemText(request)
  return {
    model: request.resolved.apiModelId,
    stream: true,
    ...(system.length > 0 ? { instructions: system } : {}),
    input: toInputItems(request.messages),
    ...(request.tools?.length ? { tools: toTools(request.tools) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
  }
}

interface CallState {
  callId: string
  name: string
  arguments: string
  emitted: boolean
}

function usageOf(value: unknown): ModelEvent | undefined {
  const usage = value as {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  } | undefined
  if (!usage) return undefined
  return {
    type: 'usage',
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.input_tokens_details?.cached_tokens,
  }
}

async function* chatAttempt(
  request: ChatRequest,
  apiKey: string | undefined,
  timeoutMs: number,
): AsyncGenerator<ModelEvent> {
  const { resolved } = request
  const url = apiUrl(resolved.endpoint.baseUrl, '/responses')
  const calls = new Map<string, CallState>()
  let sawTextDelta = false
  let finished = false

  const callEvent = (entry: CallState): ModelEvent | undefined => {
    if (entry.emitted) return undefined
    entry.emitted = true
    return {
      type: 'tool_call',
      id: entry.callId || fallbackCallId('responses'),
      name: entry.name,
      arguments: entry.arguments,
    }
  }

  const takeCall = (itemId: string, item?: Item): CallState => {
    let entry = calls.get(itemId)
    if (!entry) {
      entry = { callId: '', name: '', arguments: '', emitted: false }
      calls.set(itemId, entry)
    }
    if (item) {
      if (typeof item.call_id === 'string') entry.callId = item.call_id
      if (typeof item.name === 'string') entry.name = item.name
      if (typeof item.arguments === 'string') entry.arguments = item.arguments
    }
    return entry
  }

  for await (const message of postSSE({
    url,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(resolved.endpoint.headers ?? {}),
    },
    body: requestBody(request),
    timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  })) {
    const data = message.data.trim()
    if (data.length === 0) continue
    const json = JSON.parse(data) as {
      type?: string
      delta?: string
      item_id?: string
      arguments?: string
      item?: Item
      response?: { usage?: unknown }
      message?: string
      error?: { message?: string }
    }

    switch (json.type) {
      case 'response.output_text.delta':
        if (json.delta) {
          sawTextDelta = true
          yield { type: 'text', text: json.delta }
        }
        break

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (json.delta) yield { type: 'reasoning', text: json.delta }
        break

      case 'response.output_item.added': {
        const item = json.item
        if (item?.type === 'function_call' && typeof item.id === 'string') {
          takeCall(item.id, item)
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        if (typeof json.item_id !== 'string') break
        const entry = takeCall(json.item_id)
        if (json.delta) entry.arguments += json.delta
        break
      }

      case 'response.function_call_arguments.done': {
        if (typeof json.item_id !== 'string') break
        const entry = takeCall(json.item_id)
        if (typeof json.arguments === 'string') entry.arguments = json.arguments
        break
      }

      case 'response.output_item.done': {
        const item = json.item
        if (item?.type === 'function_call' && typeof item.id === 'string') {
          const entry = takeCall(item.id, item)
          const event = callEvent(entry)
          if (event) yield event
        } else if (item?.type === 'message' && !sawTextDelta) {
          // 少数网关只给完整 item，不给 delta。
          const content = Array.isArray(item.content) ? item.content : []
          for (const part of content) {
            const piece = part as { type?: string; text?: string }
            if (piece.type === 'output_text' && piece.text) {
              sawTextDelta = true
              yield { type: 'text', text: piece.text }
            }
          }
        }
        break
      }

      case 'response.completed':
      case 'response.incomplete': {
        const usage = usageOf(json.response?.usage)
        if (usage) yield usage
        for (const entry of calls.values()) {
          const event = callEvent(entry)
          if (event) yield event
        }
        yield { type: 'done' }
        finished = true
        return
      }

      case 'response.failed':
      case 'error':
        throw new Error(`model error: ${json.message ?? json.error?.message ?? 'response failed'}`)

      default:
        break
    }
  }

  if (!finished) {
    for (const entry of calls.values()) {
      const event = callEvent(entry)
      if (event) yield event
    }
    yield { type: 'done' }
  }
}

export async function* chatOpenAIResponses(request: ChatRequest): AsyncGenerator<ModelEvent> {
  yield* runModelRequest(request, chatAttempt)
}
