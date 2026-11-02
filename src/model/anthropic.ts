/**
 * Anthropic Messages 适配器（流式）。
 *
 * 系统提示走顶层 system；工具结果必须以 user 消息里的 tool_result 回填，
 * 所以相邻同角色消息在这里合并。
 *
 * @module if/model/anthropic
 */

import type { ContentBlock, HistoryMessage } from '../projections/history.ts'
import type { ChatRequest } from './chat.ts'
import { fallbackCallId, systemText, textOf } from './chat.ts'
import { postSSE } from './http-sse.ts'
import { runModelRequest } from './runtime.ts'
import type { ModelEvent, ToolSpec } from './types.ts'
import { apiUrl } from './urls.ts'

type Block = Record<string, unknown>
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

function toolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function userBlocks(message: HistoryMessage): Block[] {
  if (message.role === 'tool') {
    return [{
      type: 'tool_result',
      tool_use_id: message.toolUseId,
      content: message.content,
      ...(message.isError ? { is_error: true } : {}),
    }]
  }
  if (message.role !== 'user') return []

  const blocks: Block[] = []
  const text = textOf(message)
  if (text.length > 0) blocks.push({ type: 'text', text })
  for (const block of message.content) {
    if (block.type !== 'tool_result') continue
    blocks.push({
      type: 'tool_result',
      tool_use_id: block.toolUseId,
      content: block.content,
      ...(block.isError ? { is_error: true } : {}),
    })
  }
  return blocks
}

function assistantBlocks(message: HistoryMessage): Block[] {
  if (message.role !== 'assistant') return []
  const blocks: Block[] = []
  const text = textOf(message)
  if (text.length > 0) blocks.push({ type: 'text', text })
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue
    blocks.push({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: toolInput(block.input),
    })
  }
  return blocks
}

function toMessages(messages: readonly HistoryMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []

  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    if (blocks.length === 0) return
    const last = out.at(-1)
    if (last && last.role === role) {
      last.content.push(...blocks)
      return
    }
    out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user' || message.role === 'tool') {
      push('user', userBlocks(message))
      continue
    }
    push('assistant', assistantBlocks(message))
  }

  return out
}

function toTools(tools: readonly ToolSpec[]): Block[] {
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
  }))
}

function requestBody(request: ChatRequest): Record<string, unknown> {
  const system = systemText(request)
  return {
    model: request.resolved.apiModelId,
    max_tokens: request.maxTokens ?? request.resolved.model.maxOutputTokens ?? 4096,
    stream: true,
    messages: toMessages(request.messages),
    ...(system.length > 0 ? { system } : {}),
    ...(request.tools?.length ? { tools: toTools(request.tools) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }
}

interface ToolState {
  id: string
  name: string
  arguments: string
  emitted: boolean
}

async function* chatAttempt(
  request: ChatRequest,
  apiKey: string | undefined,
  timeoutMs: number,
): AsyncGenerator<ModelEvent> {
  const { resolved } = request
  const url = apiUrl(resolved.endpoint.baseUrl, '/messages')
  const blocks = new Map<number, ToolState>()
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let usageEmitted = false
  let finished = false

  const callEvent = (entry: ToolState): ModelEvent | undefined => {
    if (entry.emitted) return undefined
    entry.emitted = true
    return {
      type: 'tool_call',
      id: entry.id,
      name: entry.name,
      arguments: entry.arguments || '{}',
    }
  }

  const usageEvent = (): ModelEvent | undefined => {
    if (usageEmitted) return undefined
    usageEmitted = true
    if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
      return undefined
    }
    return {
      type: 'usage',
      input: inputTokens,
      output: outputTokens,
      cacheRead,
      cacheWrite,
    }
  }

  for await (const message of postSSE({
    url,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
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
      index?: number
      message?: { usage?: Record<string, number> }
      content_block?: {
        type?: string
        id?: string
        name?: string
        text?: string
        input?: unknown
      }
      delta?: {
        type?: string
        text?: string
        thinking?: string
        partial_json?: string
      }
      usage?: Record<string, number>
      error?: { message?: string }
    }

    switch (json.type) {
      case 'message_start': {
        const usage = json.message?.usage ?? {}
        inputTokens = usage.input_tokens ?? inputTokens
        cacheRead = usage.cache_read_input_tokens ?? cacheRead
        cacheWrite = usage.cache_creation_input_tokens ?? cacheWrite
        break
      }

      case 'content_block_start': {
        const block = json.content_block
        const index = json.index ?? blocks.size
        if (block?.type === 'tool_use') {
          blocks.set(index, {
            id: block.id ?? fallbackCallId('anthropic'),
            name: block.name ?? '',
            arguments: block.input && Object.keys(block.input).length > 0
              ? JSON.stringify(block.input)
              : '',
            emitted: false,
          })
        } else if (block?.type === 'text' && block.text) {
          yield { type: 'text', text: block.text }
        }
        break
      }

      case 'content_block_delta': {
        const delta = json.delta
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text', text: delta.text }
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', text: delta.thinking }
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const entry = blocks.get(json.index ?? -1)
          if (entry) entry.arguments += delta.partial_json
        }
        break
      }

      case 'content_block_stop': {
        const entry = blocks.get(json.index ?? -1)
        if (entry) {
          const event = callEvent(entry)
          if (event) yield event
        }
        break
      }

      case 'message_delta': {
        const usage = json.usage ?? {}
        if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
        const event = usageEvent()
        if (event) yield event
        break
      }

      case 'message_stop': {
        const event = usageEvent()
        if (event) yield event
        yield { type: 'done' }
        finished = true
        return
      }

      case 'error':
        throw new Error(`model error: ${json.error?.message ?? 'anthropic stream error'}`)

      default:
        break
    }
  }

  if (!finished) {
    for (const entry of blocks.values()) {
      const event = callEvent(entry)
      if (event) yield event
    }
    const event = usageEvent()
    if (event) yield event
    yield { type: 'done' }
  }
}

export async function* chatAnthropic(request: ChatRequest): AsyncGenerator<ModelEvent> {
  yield* runModelRequest(request, chatAttempt)
}
