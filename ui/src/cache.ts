import type { UiTimelineItem } from './types'

interface CachedTurn {
  items: UiTimelineItem[]
  bytes: number
  lastUsed: number
}

/** 帧内页缓存：只保留附近几轮，远处整轮释放。 */
export class TurnCache {
  private readonly turns = new Map<number, CachedTurn>()
  private readonly maxTurns = 40
  private readonly maxBytes = 24 * 1024 * 1024

  get(turn: number): UiTimelineItem[] | undefined {
    const entry = this.turns.get(turn)
    if (!entry) return undefined
    entry.lastUsed = Date.now()
    return entry.items
  }

  set(turn: number, items: UiTimelineItem[]): void {
    const bytes = items.reduce((sum, item) => sum
      + (item.content?.bytes ?? 0)
      + (item.tool?.argsBytes ?? 0)
      + (item.tool?.result?.bytes ?? 0), 0)
    this.turns.set(turn, { items, bytes, lastUsed: Date.now() })
    this.evict()
  }

  delete(turn: number): void {
    this.turns.delete(turn)
  }

  clear(): void {
    this.turns.clear()
  }

  /** 当前视口之外的轮先丢；仍然超预算再按最久未用丢。 */
  evictOutside(visible: Set<number>): void {
    for (const turn of [...this.turns.keys()]) {
      if (!visible.has(turn)) this.turns.delete(turn)
    }
    this.evict(visible)
  }

  private evict(keep = new Set<number>()): void {
    let bytes = 0
    for (const entry of this.turns.values()) bytes += entry.bytes
    if (this.turns.size <= this.maxTurns && bytes <= this.maxBytes) return

    const candidates = [...this.turns.entries()]
      .filter(([turn]) => !keep.has(turn))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)

    for (const [turn, entry] of candidates) {
      if (this.turns.size <= this.maxTurns && bytes <= this.maxBytes) break
      this.turns.delete(turn)
      bytes -= entry.bytes
    }
  }
}
