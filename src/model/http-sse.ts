/**
 * 发 POST 并读 SSE，统一超时、中断与非 2xx。
 *
 * @module if/model/http-sse
 */

import { ModelHttpError, ModelTimeoutError, parseRetryAfter } from './retry.ts'
import { readSSE, type SSEMessage } from './sse.ts'

export interface SSERequest {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body: unknown
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export async function* postSSE(request: SSERequest): AsyncGenerator<SSEMessage> {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', onAbort, { once: true })
  if (request.signal?.aborted) controller.abort(request.signal.reason)

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new ModelTimeoutError(request.timeoutMs))
  }, request.timeoutMs)
  timer.unref?.()

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...(request.headers ?? {}),
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ModelHttpError(
        response.status,
        text,
        parseRetryAfter(response.headers.get('retry-after')),
      )
    }
    if (!response.body) throw new Error('model response has no body')
    yield* readSSE(response.body)
  } catch (error) {
    if (timedOut) throw new ModelTimeoutError(request.timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}
