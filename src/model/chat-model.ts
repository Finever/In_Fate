/**
 * 按端点格式选择适配器。上层只认 ChatRequest / ModelEvent。
 *
 * @module if/model/chat-model
 */

import { chatAnthropic } from './anthropic.ts'
import { chatGoogle } from './google.ts'
import type { ChatRequest } from './chat.ts'
import { chatOpenAI } from './openai.ts'
import { chatOpenAIResponses } from './openai-responses.ts'
import type { ModelEvent } from './types.ts'

export type EndpointFamily =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generate-content'

export function normalizeEndpointFamily(value: string | undefined): EndpointFamily {
  switch (value) {
    case undefined:
    case '':
    case 'openai':
    case 'openai-compatible':
    case 'openai-chat-completions':
    case 'deepseek':
    case 'cherryin':
    case 'openrouter':
    case 'groq':
    case 'mistral':
    case 'xai':
    case 'ollama':
    case 'lmstudio':
      return 'openai-chat-completions'
    case 'openai-responses':
      return 'openai-responses'
    case 'anthropic':
    case 'anthropic-messages':
      return 'anthropic-messages'
    case 'google':
    case 'gemini':
    case 'google-generate-content':
      return 'google-generate-content'
    default:
      throw new Error(`unsupported model endpoint format: ${value}`)
  }
}

export function resolveEndpointFamily(request: ChatRequest): EndpointFamily {
  return normalizeEndpointFamily(
    request.resolved.family
      ?? request.resolved.endpoint.adapterFamily
      ?? request.resolved.provider.defaultChatEndpoint,
  )
}

/** 流式对话；按 provider 配置的端点格式分发。 */
export async function* chatModel(request: ChatRequest): AsyncGenerator<ModelEvent> {
  switch (resolveEndpointFamily(request)) {
    case 'openai-chat-completions':
      yield* chatOpenAI(request)
      return
    case 'openai-responses':
      yield* chatOpenAIResponses(request)
      return
    case 'anthropic-messages':
      yield* chatAnthropic(request)
      return
    case 'google-generate-content':
      yield* chatGoogle(request)
      return
  }
}
