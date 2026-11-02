/**
 * Google Gemini Generate Content 适配器（流式，alt=sse）。
 *
 * 角色只有 user / model；工具结果用 functionResponse 回填在 user 内容里。
 * functionResponse 需要函数名，所以先扫一遍历史里的 tool_use 建映射。
 *
 * @module if/model/google
 */

import type { HistoryMessage } from '../projections/history.ts'
import type { ChatRequest } from './chat.ts'
import { fallbackCallId, systemText, textOf } from './chat.ts'
import { postSSE } from './http-sse.ts'
import { runModelRequest } from './runtime.ts'
import type { ModelEvent, ToolSpec } from './types.ts'
import { apiUrl } from './urls.ts'

interface GooglePart {
  text?: string
  thought?: boolean
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name?: string; response?: unknown }
}

interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

function toolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function toolNames(messages: readonly HistoryMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name)
    }
  }
  return names
}

function resultPart(
  toolUseId: string,
  content: string,
  isError: boolean | undefined,
  names: Map<string, string>,
): GooglePart {
  return {
    functionResponse: {
      name: names.get(toolUseId) ?? toolUseId,
      response: isError ? { error: content } : { result: content },
    },
  }
}

function toContents(messages: readonly HistoryMessage[]): GoogleContent[] {
  const names = toolNames(messages)
  const out: GoogleContent[] = []

  const push = (role: 'user' | 'model', parts: GooglePart[]): void => {
    if (parts.length === 0) return
    const last = out.at(-1)
    if (last && last.role === role) {
      last.parts.push(...parts)
      return
    }
    out.push({ role, parts })
  }

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      push('user', [resultPart(message.toolUseId, message.content, message.isError, names)])
      continue
    }

    if (message.role === 'user') {
      const parts: GooglePart[] = []
      const text = textOf(message)
      if (text.length > 0) parts.push({ text })
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue
        parts.push(resultPart(block.toolUseId, block.content, block.isError, names))
      }
      push('user', parts)
      continue
    }

    const parts: GooglePart[] = []
    const text = textOf(message)
    if (text.length > 0) parts.push({ text })
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      parts.push({
        functionCall: { name: block.name, args: toolArgs(block.input) },
      })
    }
    push('model', parts)
  }

  return out
}

function toTools(tools: readonly ToolSpec[]): Record<string, unknown>[] {
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    })),
  }]
}

function requestBody(request: ChatRequest): Record<string, unknown> {
  const system = systemText(request)
  const generationConfig = {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
  }
  return {
    contents: toContents(request.messages),
    ...(system.length > 0 ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(request.tools?.length ? { tools: toTools(request.tools) } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
}

interface Usage {
  input?: number
  output?: number
  cacheRead?: number
}

function usageOf(value: {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
} | undefined): Usage | undefined {
  if (!value) return undefined
  return {
    input: value.promptTokenCount,
    output: value.candidatesTokenCount,
    cacheRead: value.cachedContentTokenCount,
  }
}

async function* chatAttempt(
  request: ChatRequest,
  apiKey: string | undefined,
  timeoutMs: number,
): AsyncGenerator<ModelEvent> {
  const { resolved } = request
  const model = resolved.apiModelId.replace(/^models\//, '')
  const url = apiUrl(
    resolved.endpoint.baseUrl,
    `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    'v1beta',
  )
  let usage: Usage | undefined
  let usageEmitted = false
  let sawContent = false

  const usageEvent = (): ModelEvent | undefined => {
    if (usageEmitted || !usage) return undefined
    usageEmitted = true
    return {
      type: 'usage',
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
    }
  }

  for await (const message of postSSE({
    url,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
      ...(resolved.endpoint.headers ?? {}),
    },
    body: requestBody(request),
    timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  })) {
    const data = message.data.trim()
    if (data.length === 0) continue
    const json = JSON.parse(data) as {
      candidates?: {
        content?: { parts?: GooglePart[] }
        finishReason?: string
      }[]
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        cachedContentTokenCount?: number
      }
      promptFeedback?: { blockReason?: string }
      error?: { message?: string }
    }

    if (json.error?.message) throw new Error(`model error: ${json.error.message}`)
    if (json.promptFeedback?.blockReason) {
      throw new Error(`model blocked: ${json.promptFeedback.blockReason}`)
    }
    if (json.usageMetadata) usage = usageOf(json.usageMetadata)

    const candidate = json.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        sawContent = true
        yield {
          type: 'tool_call',
          id: fallbackCallId('google'),
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        }
        continue
      }
      if (part.text) {
        sawContent = true
        if (part.thought === true) yield { type: 'reasoning', text: part.text }
        else yield { type: 'text', text: part.text }
      }
    }

    if (candidate?.finishReason) {
      if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL') {
        throw new Error('model error: malformed function call')
      }
      if (candidate.finishReason === 'SAFETY' && !sawContent) {
        throw new Error('model blocked: SAFETY')
      }
      // 不在这里提前 return：有些网关把 usageMetadata 放在 finishReason 之后一块。
    }
  }

  const event = usageEvent()
  if (event) yield event
  yield { type: 'done' }
}

export async function* chatGoogle(request: ChatRequest): AsyncGenerator<ModelEvent> {
  yield* runModelRequest(request, chatAttempt)
}
