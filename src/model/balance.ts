import type { ProviderConfig } from './types.ts'

export interface BalanceAmount {
  readonly currency: string
  readonly total: number
  readonly available: number
  readonly granted?: number
  readonly toppedUp?: number
  readonly totalUsage?: number
}

export interface ModelBalance {
  readonly provider: string
  readonly keyId: string
  readonly checkedAt: string
  readonly source: 'api'
  readonly balances: readonly BalanceAmount[]
}

export interface ModelBalanceQueryInput {
  readonly provider: ProviderConfig
  readonly keyId: string
  readonly apiKey: string
  readonly baseUrl: string
  /** true = 跳过 60 秒缓存。 */
  readonly force?: boolean
  readonly signal?: AbortSignal
}

export type BalanceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface ModelBalanceServiceOptions {
  readonly fetch?: BalanceFetch
  readonly now?: () => Date
  readonly ttlMs?: number
  readonly timeoutMs?: number
}

export class BalanceUnsupportedError extends Error {
  readonly code = 'balance_unsupported' as const

  constructor(message: string) {
    super(message)
    this.name = 'BalanceUnsupportedError'
  }
}

export class BalanceInputError extends Error {
  readonly code = 'balance_input' as const

  constructor(message: string) {
    super(message)
    this.name = 'BalanceInputError'
  }
}

export class BalanceQueryError extends Error {
  readonly code = 'balance_unavailable' as const
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BalanceQueryError'
    this.status = status
  }
}

interface BalanceAdapter {
  readonly id: string
  supports(provider: ProviderConfig, baseUrl: string): boolean
  url(baseUrl: string): string
  parse(raw: unknown): BalanceAmount[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new BalanceQueryError('上游余额接口返回的不是对象')
  return value
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = numberOf(value)
  if (parsed === undefined) throw new BalanceQueryError(`余额响应缺少 ${field}`)
  return parsed
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

const deepSeek: BalanceAdapter = {
  id: 'deepseek',
  supports(provider, baseUrl) {
    const host = hostOf(baseUrl)
    return provider.id === 'deepseek'
      || host === 'api.deepseek.com'
      || host.endsWith('.deepseek.com')
  },
  url(baseUrl) {
    const host = hostOf(baseUrl)
    return host.endsWith('deepseek.com')
      ? `${originOf(baseUrl)}/user/balance`
      : `${trimBase(baseUrl).replace(/\/v1$/i, '')}/user/balance`
  },
  parse(raw) {
    const record = asRecord(raw)
    const infos = Array.isArray(record.balance_infos) ? record.balance_infos : []
    if (infos.length === 0) throw new BalanceQueryError('余额响应缺少 balance_infos')
    return infos.map(item => {
      const row = asRecord(item)
      const total = requiredNumber(row.total_balance, 'total_balance')
      const granted = numberOf(row.granted_balance)
      const toppedUp = numberOf(row.topped_up_balance)
      return {
        currency: typeof row.currency === 'string' && row.currency.trim()
          ? row.currency.trim()
          : 'CNY',
        total,
        available: total,
        ...(granted !== undefined ? { granted } : {}),
        ...(toppedUp !== undefined ? { toppedUp } : {}),
      }
    })
  },
}

const moonshot: BalanceAdapter = {
  id: 'moonshot',
  supports(provider, baseUrl) {
    const host = hostOf(baseUrl)
    return provider.id === 'moonshot'
      || host.includes('moonshot')
      || host === 'api.kimi.com'
      || host.endsWith('.kimi.com')
  },
  url(baseUrl) {
    const host = hostOf(baseUrl)
    return host.includes('moonshot') || host.endsWith('kimi.com')
      ? `${originOf(baseUrl)}/v1/users/me/balance`
      : `${trimBase(baseUrl)}/users/me/balance`
  },
  parse(raw) {
    const root = asRecord(asRecord(raw).data ?? raw)
    const available = numberOf(root.available_balance)
    const cash = numberOf(root.cash_balance)
    const voucher = numberOf(root.voucher_balance)
    if (available === undefined && (cash === undefined || voucher === undefined)) {
      throw new BalanceQueryError('余额响应缺少 available_balance')
    }
    const total = cash !== undefined && voucher !== undefined
      ? cash + voucher
      : available!
    return [{
      currency: typeof root.currency === 'string' && root.currency.trim()
        ? root.currency.trim()
        : 'CNY',
      total,
      available: available ?? total,
      ...(voucher !== undefined ? { granted: voucher } : {}),
      ...(cash !== undefined ? { toppedUp: cash } : {}),
    }]
  },
}

const openRouter: BalanceAdapter = {
  id: 'openrouter',
  supports(provider, baseUrl) {
    const host = hostOf(baseUrl)
    return provider.id === 'openrouter'
      || host === 'openrouter.ai'
      || host.endsWith('.openrouter.ai')
  },
  url(baseUrl) {
    const host = hostOf(baseUrl)
    return host.endsWith('openrouter.ai')
      ? `${originOf(baseUrl)}/api/v1/credits`
      : `${trimBase(baseUrl)}/credits`
  },
  parse(raw) {
    const root = asRecord(asRecord(raw).data ?? raw)
    const total = requiredNumber(root.total_credits, 'total_credits')
    const usage = numberOf(root.total_usage) ?? 0
    return [{
      currency: 'USD',
      total,
      available: total - usage,
      totalUsage: usage,
    }]
  },
}

const ADAPTERS: readonly BalanceAdapter[] = [deepSeek, moonshot, openRouter]

function httpMessage(status: number): string {
  if (status === 401 || status === 403) {
    return '这个 key 没有读取余额的权限（HTTP 401/403）'
  }
  if (status === 404) return '上游没有提供余额接口（HTTP 404）'
  if (status === 429) return '余额查询被上游限流（HTTP 429）'
  return `上游余额接口返回 HTTP ${status}`
}

export class ModelBalanceService {
  private readonly fetchImpl: BalanceFetch
  private readonly now: () => Date
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly cache = new Map<string, {
    readonly expires: number
    readonly value: ModelBalance
  }>()

  constructor(options: ModelBalanceServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? (() => new Date())
    this.ttlMs = options.ttlMs ?? 60_000
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  supports(provider: ProviderConfig, baseUrl: string): boolean {
    return this.adapterFor(provider, baseUrl) !== undefined
  }

  async query(input: ModelBalanceQueryInput): Promise<ModelBalance> {
    const adapter = this.adapterFor(input.provider, input.baseUrl)
    if (!adapter) {
      throw new BalanceUnsupportedError(
        `provider ${input.provider.id} does not expose a balance API`,
      )
    }
    const cacheKey = `${input.provider.id}\u0000${input.keyId}\u0000${input.baseUrl}`
    if (!input.force) {
      const now = this.now().getTime()
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expires > now) return cached.value
    }

    const balances = await this.request(adapter, input)
    const value: ModelBalance = {
      provider: input.provider.id,
      keyId: input.keyId,
      checkedAt: this.now().toISOString(),
      source: 'api',
      balances,
    }
    this.cache.set(cacheKey, {
      expires: this.now().getTime() + this.ttlMs,
      value,
    })
    return value
  }

  private adapterFor(provider: ProviderConfig, baseUrl: string): BalanceAdapter | undefined {
    return ADAPTERS.find(adapter => adapter.supports(provider, baseUrl))
  }

  private async request(
    adapter: BalanceAdapter,
    input: ModelBalanceQueryInput,
  ): Promise<BalanceAmount[]> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(input.signal?.reason)
    if (input.signal?.aborted) controller.abort(input.signal.reason)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('balance timeout')),
      this.timeoutMs,
    )
    try {
      const response = await this.fetchImpl(adapter.url(input.baseUrl), {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.apiKey}`,
        },
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new BalanceQueryError(httpMessage(response.status), response.status)
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new BalanceQueryError('上游余额接口返回的不是 JSON')
      }
      return adapter.parse(raw)
    } catch (error) {
      if (error instanceof BalanceQueryError) throw error
      if (input.signal?.aborted) throw new BalanceQueryError('余额查询已取消')
      if (controller.signal.aborted) {
        throw new BalanceQueryError(`余额查询超时（${Math.round(this.timeoutMs / 1000)} 秒）`)
      }
      throw new BalanceQueryError(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}
