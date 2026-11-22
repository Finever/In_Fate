import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isoWeekInfo,
  periodEndInclusive,
  periodLabel,
  periodStart,
  shiftPeriod,
} from '../ui/src/lib/usage-period.ts'

test('报告周期：ISO 周从周一起，跨年周归 ISO 年', () => {
  // 2026-11-23 是周一；2026-11-22 是周日，属于 11-16 那一周。
  const monday = new Date(2026, 10, 23)
  assert.equal(periodStart('week', monday).getDate(), 23)
  const sunday = new Date(2026, 10, 22)
  const weekOfSunday = periodStart('week', sunday)
  assert.equal(weekOfSunday.getDate(), 16)
  assert.equal(weekOfSunday.getMonth(), 10)
  assert.equal(periodEndInclusive('week', weekOfSunday).getDate(), 22)

  // 跨年：2025-12-29（周一）所在周是 2026 年 W01，标签跨月正确。
  const cross = periodStart('week', new Date(2025, 11, 29))
  const info = isoWeekInfo(cross)
  assert.deepEqual({ year: info.year, week: info.week }, { year: 2026, week: 1 })
  assert.match(periodLabel('week', cross), /2026 年 第 1 周 · 12-29 ~ 01-04/)

  // 翻页：前一/后一周都是周一。
  const prev = shiftPeriod('week', monday, -1)
  assert.equal(prev.getDate(), 16)
  assert.equal(prev.getDay(), 1)
  assert.equal(shiftPeriod('week', monday, 1).getDate(), 30)
})

test('报告周期：月/年边界、闰年与翻页', () => {
  const nov = periodStart('month', new Date(2026, 10, 15))
  assert.equal(nov.getFullYear(), 2026)
  assert.equal(nov.getMonth(), 10)
  assert.equal(nov.getDate(), 1)
  assert.equal(periodEndInclusive('month', nov).getDate(), 30)
  assert.equal(periodLabel('month', nov), '2026 年 11 月')

  // 二月：平年 28、闰年 29。
  assert.equal(periodEndInclusive('month', new Date(2026, 1, 1)).getDate(), 28)
  assert.equal(periodEndInclusive('month', new Date(2028, 1, 1)).getDate(), 29)

  // 跨年翻页。
  const dec = periodStart('month', new Date(2026, 11, 5))
  const nextJan = shiftPeriod('month', dec, 1)
  assert.equal(nextJan.getFullYear(), 2027)
  assert.equal(nextJan.getMonth(), 0)
  assert.equal(shiftPeriod('month', nextJan, -1).getMonth(), 11)
  assert.equal(shiftPeriod('month', nextJan, -1).getFullYear(), 2026)

  const year = periodStart('year', new Date(2026, 5, 1))
  assert.equal(year.getMonth(), 0)
  assert.equal(year.getDate(), 1)
  assert.equal(periodEndInclusive('year', year).getMonth(), 11)
  assert.equal(periodEndInclusive('year', year).getDate(), 31)
  assert.equal(periodLabel('year', year), '2026 年')
  assert.equal(shiftPeriod('year', year, -1).getFullYear(), 2025)
})
