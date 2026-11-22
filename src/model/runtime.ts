/**
 * 适配器共用的重试 / 准入 / key 轮换。
 *
 * 流一旦吐过事件就不再重试；多个 key 时，401/403 会换下一个 key。
 *
 * @module if/model/runtime
 */

import type { ChatRequest } from './chat.ts'
import { resolveApiKeyEntries } from './registry.ts'
import {
  ModelHttpError,
  isRetryableModelError,
  resolveRetryPolicy,
  retryDelayMs,
} from './retry.ts'
import type { ModelEvent } from './types.ts'

export type ModelAttempt = (
  request: ChatRequest,
  apiKey: string | undefined,
  timeoutMs: number,
) => AsyncGenerator<ModelEvent>

export async function* runModelRequest(
  request: ChatRequest,
  attempt: ModelAttempt,
): AsyncGenerator<ModelEvent> {
  const policy = resolveRetryPolicy(request.retry)
  const providerId = request.resolved.provider.id
  const keys = resolveApiKeyEntries(request.resolved.provider)
  const release = request.gate
    ? await request.gate.acquire({
      providerId,
      priority: request.priority ?? 'normal',
      ...(request.signal ? { signal: request.signal } : {}),
    })
    : undefined

  let attemptCount = 0
  const maxAttempts = Math.max(policy.maxAttempts, keys.length > 1 ? keys.length : 1)

  try {
    while (true) {
      attemptCount += 1
      request.onAttempt?.(attemptCount)
      const key = keys.length > 0
        ? keys[(attemptCount - 1) % keys.length]
        : undefined
      request.onKeySelected?.(key
        ? {
          ...(key.id ? { id: key.id } : {}),
          ...(key.label ? { label: key.label } : {}),
          masked: key.masked,
          source: key.source,
        }
        : { masked: '', source: 'none' })
      let emitted = 0

      try {
        for await (const event of attempt(request, key?.key, policy.timeoutMs)) {
          emitted += 1
          yield event
        }
        request.gate?.noteSuccess(providerId)
        return
      } catch (error) {
        request.gate?.noteError(providerId, error)
        if (request.signal?.aborted) throw error

        const status = error instanceof ModelHttpError ? error.status : undefined
        const keyRetry = keys.length > 1 && (status === 401 || status === 403)
        if (
          emitted > 0
          || attemptCount >= maxAttempts
          || (!isRetryableModelError(error, policy) && !keyRetry)
        ) {
          throw error
        }

        const retryAfterMs = error instanceof ModelHttpError ? error.retryAfterMs : undefined
        // 换 key 不用退避：坏 key 立刻让下一个顶上。
        const delayMs = keyRetry ? 0 : retryDelayMs(attemptCount, policy, retryAfterMs)
        request.onRetry?.({
          attempt: attemptCount,
          maxAttempts,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
          ...(status !== undefined ? { status } : {}),
        })
        await policy.sleep(delayMs, request.signal)
      }
    }
  } finally {
    release?.()
  }
}
