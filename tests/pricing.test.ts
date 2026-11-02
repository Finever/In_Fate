import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addCost,
  costOfUsage,
  effectiveRates,
  isOffPeak,
  parseClockMinutes,
  validatePricing,
} from '../src/model/pricing.ts'
import type { ModelPricing } from '../src/model/types.ts'

const standard = (n: number, currency = 'CNY') => ({ currency, perMillionTokens: n })

test('缓存命中是输入的子集，不重复计费', () => {
  const pricing: ModelPricing = {
    input: standard(1),
    output: standard(8),
    cacheRead: standard(0.1),
  }
  const cost = costOfUsage(
    pricing,
    { input: 1_000, output: 500, cacheRead: 800 },
    new Date('2026-10-31T04:00:00.000Z'),
    'Asia/Shanghai',
  )
  assert.equal(cost.priced, true)
  assert.equal(cost.currency, 'CNY')
  assert.ok(Math.abs(cost.input - 0.0002) < 1e-12)
  assert.ok(Math.abs(cost.cacheRead - 0.00008) < 1e-12)
  assert.ok(Math.abs(cost.output - 0.004) < 1e-12)
  assert.ok(Math.abs(cost.total - 0.00428) < 1e-12)
})

test('没有单价时费用为 0，priced=false', () => {
  const cost = costOfUsage(
    undefined,
    { input: 1_000, output: 500, cacheRead: 800 },
    new Date('2026-10-31T04:00:00.000Z'),
    'Asia/Shanghai',
  )
  assert.equal(cost.priced, false)
  assert.equal(cost.currency, null)
  assert.equal(cost.total, 0)
})

test('低谷时段按本地时区判断，跨午夜窗口也算昨天开始的那一段', () => {
  const windows = [{ start: '23:00', end: '08:00' }]
  const at = (iso: string) => isOffPeak(new Date(iso), windows, 'Asia/Shanghai')
  assert.equal(at('2026-10-31T14:59:00.000Z'), false) // 22:59 上海
  assert.equal(at('2026-10-31T15:00:00.000Z'), true) // 23:00
  assert.equal(at('2026-10-31T23:59:00.000Z'), true) // 07:59
  assert.equal(at('2026-11-01T00:00:00.000Z'), false) // 08:00，结束开区间
})

test('窗口按星期筛选，跨午夜后半段算开始日', () => {
  const windows = [{ days: [5], start: '23:00', end: '02:00' }] // 周五 23:00 - 周六 02:00
  const at = (iso: string) => isOffPeak(new Date(iso), windows, 'Asia/Shanghai')
  assert.equal(at('2026-10-30T15:00:00.000Z'), true) // 周五 23:00
  assert.equal(at('2026-10-30T17:30:00.000Z'), true) // 周六 01:30
  assert.equal(at('2026-10-31T15:00:00.000Z'), false) // 周日 23:00
})

test('低谷缺项回退标准价，并按请求时间选时段', () => {
  const pricing: ModelPricing = {
    input: standard(2),
    output: standard(8),
    offPeak: {
      input: standard(1),
      windows: [{ start: '00:00', end: '08:00' }],
    },
  }
  const rates = effectiveRates(
    pricing,
    new Date('2026-10-31T00:30:00.000Z'), // 08:30 上海，标准时段
    'Asia/Shanghai',
  )
  assert.equal(rates.period, 'peak')
  assert.equal(rates.output?.perMillionTokens, 8)

  const off = effectiveRates(
    pricing,
    new Date('2026-10-30T20:00:00.000Z'), // 04:00 上海，低谷
    'Asia/Shanghai',
  )
  assert.equal(off.period, 'offPeak')
  assert.equal(off.input?.perMillionTokens, 1)
  assert.equal(off.output?.perMillionTokens, 8)
})

test('跨时段费用累加后标记 mixed', () => {
  const peak = costOfUsage(
    { input: standard(2) },
    { input: 1_000_000, output: 0, cacheRead: 0 },
    new Date('2026-10-31T04:00:00.000Z'),
    'Asia/Shanghai',
  )
  const off = costOfUsage(
    {
      input: standard(2),
      offPeak: { input: standard(1), windows: [{ start: '00:00', end: '08:00' }] },
    },
    { input: 1_000_000, output: 0, cacheRead: 0 },
    new Date('2026-10-30T20:00:00.000Z'),
    'Asia/Shanghai',
  )
  const total = addCost(peak, off)
  assert.equal(total.period, 'mixed')
  assert.equal(total.total, 3)
})

test('价格校验拒绝负价、坏时间与多币种', () => {
  assert.throws(() => parseClockMinutes('24:00'))
  assert.throws(() => parseClockMinutes('8:00'))
  assert.throws(() => validatePricing({
    input: standard(-1),
  }))
  assert.throws(() => validatePricing({
    input: standard(1),
    offPeak: { windows: [] },
  }))
  assert.throws(() => validatePricing({
    input: standard(1, 'CNY'),
    output: standard(1, 'USD'),
  }))
  assert.doesNotThrow(() => validatePricing({
    input: standard(1),
    output: standard(8),
    offPeak: {
      input: standard(0.2),
      windows: [{ start: '00:30', end: '08:30' }],
    },
  }))
})
