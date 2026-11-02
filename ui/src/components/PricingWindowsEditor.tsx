import type { PricingWindow } from '../types'
import { Icon } from './Icon'

const DAYS = ['日', '一', '二', '三', '四', '五', '六']

function daysOf(window: PricingWindow): number[] {
  return window.days ? [...window.days] : [0, 1, 2, 3, 4, 5, 6]
}

export function PricingWindowsEditor({
  windows,
  timeZone,
  onChange,
}: {
  windows: PricingWindow[]
  timeZone: string
  onChange: (next: PricingWindow[]) => void
}) {
  function update(index: number, patch: Partial<PricingWindow>): void {
    onChange(windows.map((window, current) =>
      current === index ? { ...window, ...patch } : window))
  }

  function toggleDay(index: number, day: number): void {
    const window = windows[index]
    if (!window) return
    const selected = new Set(daysOf(window))
    if (selected.has(day)) selected.delete(day)
    else selected.add(day)
    if (selected.size === 0) return
    update(index, {
      days: selected.size === 7 ? undefined : [...selected].sort(),
    })
  }

  return (
    <div className="fw-pricing-windows">
      <div className="fw-pricing-windows-head">
        <span>低谷时段</span>
        <small>按 {timeZone} 判断；结束早于开始表示跨午夜</small>
      </div>

      {windows.length === 0 && (
        <div className="fw-pricing-empty">还没有低谷时段。</div>
      )}

      {windows.map((window, index) => {
        const selected = new Set(daysOf(window))
        return (
          <div className="fw-pricing-window" key={index}>
            <div className="fw-pricing-days">
              {DAYS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  className={selected.has(day) ? 'is-active' : ''}
                  onClick={() => toggleDay(index, day)}
                  aria-label={`星期${label}`}
                  aria-pressed={selected.has(day)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="fw-pricing-times">
              <input
                type="time"
                value={window.start}
                onChange={event => update(index, { start: event.target.value })}
                aria-label="低谷开始时间"
              />
              <span>至</span>
              <input
                type="time"
                value={window.end}
                onChange={event => update(index, { end: event.target.value })}
                aria-label="低谷结束时间"
              />
            </div>
            <button
              type="button"
              className="fw-icon-btn"
              onClick={() => onChange(windows.filter((_, current) => current !== index))}
              aria-label="删除时段"
              title="删除时段"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        )
      })}

      <button
        type="button"
        className="fw-pricing-add"
        onClick={() => onChange([...windows, { start: '00:00', end: '08:00' }])}
      >
        <Icon name="plus" size={13} />
        添加时段
      </button>
    </div>
  )
}
