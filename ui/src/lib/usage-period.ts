/**
 * 用量报告的自然周期：周（ISO，周一起）、月、年。
 * 纯日期算术，不依赖 DOM；tests/usage-period.test.ts 直接测这里。
 */

export type ReportKind = 'week' | 'month' | 'year'

export interface ReportState {
  kind: ReportKind
  /** 这一期的起始日（周一 / 1 号 / 1 月 1 日），本地时间。 */
  start: Date
}

/** ISO 周：周为一周之始，周四定 ISO 年。 */
export function isoWeekInfo(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const isoYear = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { year: isoYear, week }
}

export function periodStart(kind: ReportKind, date: Date): Date {
  if (kind === 'week') {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d
  }
  if (kind === 'month') return new Date(date.getFullYear(), date.getMonth(), 1)
  return new Date(date.getFullYear(), 0, 1)
}

export function periodEndInclusive(kind: ReportKind, start: Date): Date {
  if (kind === 'week') {
    const d = new Date(start)
    d.setDate(d.getDate() + 6)
    return d
  }
  if (kind === 'month') return new Date(start.getFullYear(), start.getMonth() + 1, 0)
  return new Date(start.getFullYear(), 11, 31)
}

export function shiftPeriod(kind: ReportKind, start: Date, delta: number): Date {
  if (kind === 'week') {
    const d = new Date(start)
    d.setDate(d.getDate() + delta * 7)
    return d
  }
  if (kind === 'month') return new Date(start.getFullYear(), start.getMonth() + delta, 1)
  return new Date(start.getFullYear() + delta, 0, 1)
}

function mmdd(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function periodLabel(kind: ReportKind, start: Date): string {
  if (kind === 'week') {
    const { year, week } = isoWeekInfo(start)
    return `${year} 年 第 ${week} 周 · ${mmdd(start)} ~ ${mmdd(periodEndInclusive(kind, start))}`
  }
  if (kind === 'month') return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`
  return `${start.getFullYear()} 年`
}
