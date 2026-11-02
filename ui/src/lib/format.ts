export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function shortId(id: string, length = 14): string {
  if (id.length <= length) return id
  return `${id.slice(0, 7)}…${id.slice(-4)}`
}

export function formatClock(ts: string | undefined): string {
  if (!ts) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatDateTime(ts: string | undefined): string {
  if (!ts) return '—'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function relativeTime(ts: string | undefined): string {
  if (!ts) return '—'
  const time = new Date(ts).getTime()
  if (Number.isNaN(time)) return '—'
  const diff = Date.now() - time
  if (diff < 30_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

/** 实时/完成计时：一分钟内保留一位小数，超过后显示 m:ss。 */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  const total = Math.floor(ms / 1_000)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('en-US')
}

export function formatSpeed(tokens: number, durationMs: number | undefined): string {
  if (!Number.isFinite(tokens) || tokens <= 0 || !durationMs || durationMs <= 0) {
    return '0 tok/s'
  }
  const seconds = durationMs / 1_000
  return `${(tokens / seconds).toFixed(1)} tok/s`
}

export function formatCost(value: number, currency: string | null): string {
  const amount = !Number.isFinite(value) || value <= 0
    ? '0'
    : value >= 1
      ? value.toFixed(2)
      : value >= 0.01
        ? value.toFixed(4)
        : value < 0.000001
          ? '<0.000001'
          : value.toFixed(6)
  if (!currency) return amount
  const symbol = currency === 'CNY'
    ? '¥'
    : currency === 'USD'
      ? '$'
      : currency === 'EUR'
        ? '€'
        : `${currency} `
  return `${symbol}${amount}`
}

export function formatPercent(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%'
  return `${((value / total) * 100).toFixed(1)}%`
}
