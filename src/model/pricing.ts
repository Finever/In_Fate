import type {
  ModelPriceSet,
  ModelPricing,
  PriceRate,
  PricingWindow,
} from './types.ts'

export interface UsageForCost {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite?: number
}

export type PricePeriod = 'standard' | 'peak' | 'offPeak'

export interface CostBreakdown {
  readonly currency: string | null
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
  readonly priced: boolean
  readonly period: PricePeriod | 'mixed'
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function parseClockMinutes(value: string): number {
  const match = CLOCK.exec(value)
  if (!match) throw new Error(`invalid HH:mm: ${JSON.stringify(value)}`)
  return Number(match[1]) * 60 + Number(match[2])
}

interface LocalParts {
  readonly day: number
  readonly minutes: number
}

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const weekday = parts.find(part => part.type === 'weekday')?.value ?? 'Sun'
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0')
  const day = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number])
  return {
    day: day >= 0 ? day : 0,
    minutes: hour * 60 + minute,
  }
}

function windowDays(window: PricingWindow): ReadonlySet<number> {
  return new Set(window.days ?? [0, 1, 2, 3, 4, 5, 6])
}

/** 当前时刻是否落在任一低谷窗口内。 */
export function isOffPeak(
  at: Date,
  windows: readonly PricingWindow[],
  timeZone: string,
): boolean {
  const local = localParts(at, timeZone)
  for (const window of windows) {
    const start = parseClockMinutes(window.start)
    const end = parseClockMinutes(window.end)
    if (start === end) continue
    const days = windowDays(window)
    if (start < end) {
      if (days.has(local.day) && local.minutes >= start && local.minutes < end) return true
      continue
    }
    // 跨午夜：今天 [start,24:00)，或昨天 [00:00,end)。
    if (days.has(local.day) && local.minutes >= start) return true
    const previous = (local.day + 6) % 7
    if (days.has(previous) && local.minutes < end) return true
  }
  return false
}

function nonEmptyRate(rate: PriceRate | undefined): rate is PriceRate {
  return rate !== undefined
}

function currencyOf(...rates: Array<PriceRate | undefined>): string | null {
  for (const rate of rates) {
    if (rate) return rate.currency
  }
  return null
}

function rateCost(tokens: number, rate: PriceRate | undefined): number {
  if (!rate || tokens <= 0) return 0
  return (tokens * rate.perMillionTokens) / 1_000_000
}

export interface EffectiveRates {
  readonly period: PricePeriod
  readonly input?: PriceRate
  readonly output?: PriceRate
  readonly cacheRead?: PriceRate
  readonly cacheWrite?: PriceRate
}

/** 选出当前时段的有效单价；低谷缺项回退标准价。 */
export function effectiveRates(
  pricing: ModelPricing,
  at: Date,
  timeZone: string,
): EffectiveRates {
  const offPeak = pricing.offPeak
  if (!offPeak) {
    return {
      period: 'standard',
      ...(pricing.input ? { input: pricing.input } : {}),
      ...(pricing.output ? { output: pricing.output } : {}),
      ...(pricing.cacheRead ? { cacheRead: pricing.cacheRead } : {}),
      ...(pricing.cacheWrite ? { cacheWrite: pricing.cacheWrite } : {}),
    }
  }
  if (!isOffPeak(at, offPeak.windows, timeZone)) {
    return {
      period: 'peak',
      ...(pricing.input ? { input: pricing.input } : {}),
      ...(pricing.output ? { output: pricing.output } : {}),
      ...(pricing.cacheRead ? { cacheRead: pricing.cacheRead } : {}),
      ...(pricing.cacheWrite ? { cacheWrite: pricing.cacheWrite } : {}),
    }
  }
  return {
    period: 'offPeak',
    ...(offPeak.input ?? pricing.input ? { input: offPeak.input ?? pricing.input } : {}),
    ...(offPeak.output ?? pricing.output ? { output: offPeak.output ?? pricing.output } : {}),
    ...(offPeak.cacheRead ?? pricing.cacheRead
      ? { cacheRead: offPeak.cacheRead ?? pricing.cacheRead }
      : {}),
    ...(offPeak.cacheWrite ?? pricing.cacheWrite
      ? { cacheWrite: offPeak.cacheWrite ?? pricing.cacheWrite }
      : {}),
  }
}

/** 一次模型请求的费用。没有价格时返回 priced:false 和全 0。 */
export function costOfUsage(
  pricing: ModelPricing | undefined,
  usage: UsageForCost,
  at: Date,
  timeZone: string,
): CostBreakdown {
  if (!pricing) {
    return {
      currency: null,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      priced: false,
      period: 'standard',
    }
  }
  const rates = effectiveRates(pricing, at, timeZone)
  const billableInput = Math.max(0, usage.input - usage.cacheRead)
  const input = rateCost(billableInput, rates.input)
  const cacheRead = rateCost(usage.cacheRead, rates.cacheRead ?? rates.input)
  const output = rateCost(usage.output, rates.output)
  const cacheWrite = rateCost(usage.cacheWrite ?? 0, rates.cacheWrite)
  const priced = nonEmptyRate(rates.input)
    || nonEmptyRate(rates.output)
    || nonEmptyRate(rates.cacheRead)
    || nonEmptyRate(rates.cacheWrite)
  return {
    currency: currencyOf(rates.input, rates.output, rates.cacheRead, rates.cacheWrite),
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + cacheRead + output + cacheWrite,
    priced,
    period: rates.period,
  }
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const period = a.period === b.period ? a.period : 'mixed'
  return {
    currency: a.currency === b.currency ? a.currency : (a.currency ?? b.currency),
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    priced: a.priced || b.priced,
    period,
  }
}

function validateRate(rate: PriceRate | undefined, path: string): void {
  if (!rate) return
  if (typeof rate.currency !== 'string' || rate.currency.trim().length === 0) {
    throw new Error(`${path}.currency must be a non-empty string`)
  }
  if (!Number.isFinite(rate.perMillionTokens) || rate.perMillionTokens < 0) {
    throw new Error(`${path}.perMillionTokens must be a non-negative number`)
  }
}

function validatePriceSet(set: ModelPriceSet, path: string): void {
  validateRate(set.input, `${path}.input`)
  validateRate(set.output, `${path}.output`)
  validateRate(set.cacheRead, `${path}.cacheRead`)
  validateRate(set.cacheWrite, `${path}.cacheWrite`)
}

function validateWindow(window: PricingWindow, path: string): void {
  const start = parseClockMinutes(window.start)
  const end = parseClockMinutes(window.end)
  if (start === end) throw new Error(`${path} start and end must differ`)
  if (window.days !== undefined) {
    if (!Array.isArray(window.days) || window.days.length === 0) {
      throw new Error(`${path}.days must be a non-empty array when set`)
    }
    const seen = new Set<number>()
    for (const day of window.days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(`${path}.days must contain integers 0-6`)
      }
      if (seen.has(day)) throw new Error(`${path}.days contains duplicate ${day}`)
      seen.add(day)
    }
  }
}

export function validatePricing(pricing: ModelPricing, path = 'pricing'): void {
  validatePriceSet(pricing, path)
  const offPeak = pricing.offPeak
  if (offPeak) {
    validatePriceSet(offPeak, `${path}.offPeak`)
    if (!Array.isArray(offPeak.windows) || offPeak.windows.length === 0) {
      throw new Error(`${path}.offPeak.windows must contain at least one window`)
    }
    offPeak.windows.forEach((window, index) => {
      validateWindow(window, `${path}.offPeak.windows[${index}]`)
    })
  }

  const currencies = [
    pricing.input?.currency,
    pricing.output?.currency,
    pricing.cacheRead?.currency,
    pricing.cacheWrite?.currency,
    offPeak?.input?.currency,
    offPeak?.output?.currency,
    offPeak?.cacheRead?.currency,
    offPeak?.cacheWrite?.currency,
  ].filter((value): value is string => typeof value === 'string')
  const unique = new Set(currencies.map(value => value.trim().toUpperCase()))
  if (unique.size > 1) throw new Error(`${path} must use one currency per model`)
}
