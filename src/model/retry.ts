export interface ModelRetryPolicy {
  /** 总尝试次数，含第一次；1 表示不重试 */
  readonly maxAttempts?: number
  /** 指数退避基准 */
  readonly baseDelayMs?: number
  /** 单次退避上限，也是 Retry-After 的上限 */
  readonly maxDelayMs?: number
  /** 单次尝试的超时（毫秒） */
  readonly timeoutMs?: number
  /** 超时是否重试；默认 true */
  readonly retryOnTimeout?: boolean
  /** 额外视为可重试的 HTTP 状态码 */
  readonly retryOnStatus?: readonly number[]
  /** 是否尊重服务端 Retry-After */
  readonly respectRetryAfter?: boolean
  /** 测试注入：睡眠 */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 测试注入：0..1 随机数 */
  readonly random?: () => number
}

export interface ResolvedModelRetry {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly timeoutMs: number
  readonly retryOnTimeout: boolean
  readonly retryOnStatus: readonly number[]
  readonly respectRetryAfter: boolean
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random: () => number
}

export const DEFAULT_MODEL_RETRY: ResolvedModelRetry = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  timeoutMs: 180_000,
  retryOnTimeout: true,
  retryOnStatus: [408, 409, 425, 429, 500, 502, 503, 504],
  respectRetryAfter: true,
  sleep: sleepWithAbort,
  random: Math.random,
}

export class ModelHttpError extends Error {
  readonly status: number
  readonly retryAfterMs?: number

  constructor(status: number, detail: string, retryAfterMs?: number) {
    super(`model http ${status}: ${detail.slice(0, 500)}`)
    this.name = 'ModelHttpError'
    this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

export class ModelTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`model timeout after ${timeoutMs}ms`)
    this.name = 'ModelTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface ModelRetryInfo {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly error: string
  readonly status?: number
}

export function resolveRetryPolicy(patch?: ModelRetryPolicy): ResolvedModelRetry {
  return {
    maxAttempts: Math.max(1, Math.floor(patch?.maxAttempts ?? DEFAULT_MODEL_RETRY.maxAttempts)),
    baseDelayMs: Math.max(0, patch?.baseDelayMs ?? DEFAULT_MODEL_RETRY.baseDelayMs),
    maxDelayMs: Math.max(0, patch?.maxDelayMs ?? DEFAULT_MODEL_RETRY.maxDelayMs),
    timeoutMs: Math.max(1, patch?.timeoutMs ?? DEFAULT_MODEL_RETRY.timeoutMs),
    retryOnTimeout: patch?.retryOnTimeout ?? DEFAULT_MODEL_RETRY.retryOnTimeout,
    retryOnStatus: patch?.retryOnStatus ?? DEFAULT_MODEL_RETRY.retryOnStatus,
    respectRetryAfter: patch?.respectRetryAfter ?? DEFAULT_MODEL_RETRY.respectRetryAfter,
    sleep: patch?.sleep ?? DEFAULT_MODEL_RETRY.sleep,
    random: patch?.random ?? DEFAULT_MODEL_RETRY.random,
  }
}

/** 可重试：超时、网络异常、以及策略列出的 HTTP 状态。 */
export function isRetryableModelError(
  error: unknown,
  policy: ResolvedModelRetry,
): boolean {
  if (error instanceof ModelTimeoutError) return policy.retryOnTimeout
  if (error instanceof ModelHttpError) {
    return error.status >= 500 || policy.retryOnStatus.includes(error.status)
  }
  // fetch 的网络错误是 TypeError；AbortError 由调用方先排除。
  return error instanceof TypeError
}

/** Retry-After 支持秒数与 HTTP 日期；解析不了就当没有。 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return undefined
}

/**
 * 指数退避 + 抖动；服务端给了 Retry-After 就至少等那么久。
 * 上限统一由 maxDelayMs 压住，防止恶意响应拖死一轮。
 */
export function retryDelayMs(
  attempt: number,
  policy: ResolvedModelRetry,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  )
  const jittered = Math.floor(exponential * (0.5 + 0.5 * policy.random()))
  const candidate = retryAfterMs !== undefined && policy.respectRetryAfter
    ? Math.max(jittered, retryAfterMs)
    : jittered
  return Math.min(policy.maxDelayMs, Math.max(0, candidate))
}

/** 可中断的睡眠；外部 abort 不当作重试失败，直接抛出原因。 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    // 不 unref：退避期间如果进程没有别的句柄，unref 会让 Node 直接退出，
    // 重试还没发生就被掐掉。
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
