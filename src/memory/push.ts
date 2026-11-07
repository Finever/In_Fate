/**
 * Jev 推送：按策略选择一次记忆包，并缓存 once 语义。
 *
 * 选择器本身是同步的；真正的模型选择器以后可以替换，但不改这里。
 *
 * @module if/memory/push
 */

import type { HistoryMessage } from '../projections/history.ts'
import type { MemoryPolicyStore } from './policy.ts'
import type { MemoryPacket, MemorySelector } from './selector.ts'

export interface PushedMemory {
  readonly packet: MemoryPacket
  readonly segment: string
  readonly reused: boolean
}

export interface MemoryPushOptions {
  readonly selector: MemorySelector
  readonly policy: MemoryPolicyStore
  /** 当前上下文分段；默认用压缩事件 id。 */
  readonly segmentKeyFor: (sessionId: string) => string
}

export class MemoryPushService {
  private readonly selector: MemorySelector
  private readonly policy: MemoryPolicyStore
  private readonly segmentKeyFor: (sessionId: string) => string
  private readonly cache = new Map<string, { segment: string; packet: MemoryPacket }>()

  constructor(options: MemoryPushOptions) {
    this.selector = options.selector
    this.policy = options.policy
    this.segmentKeyFor = options.segmentKeyFor
  }

  /** 记忆写入/结构变化后清缓存；下一轮重新选择。 */
  invalidate(sessionId?: string): void {
    if (sessionId) this.cache.delete(sessionId)
    else this.cache.clear()
  }

  packetFor(sessionId: string, history: readonly HistoryMessage[]): PushedMemory | undefined {
    const policy = this.policy.resolve(sessionId)
    if (policy.mode !== 'jev-push' || policy.jev.enabled === 'off') return undefined
    const segment = this.segmentKeyFor(sessionId)
    const cached = this.cache.get(sessionId)

    if (policy.jev.enabled === 'once' && cached) {
      if (cached.segment === segment) return { packet: cached.packet, segment, reused: true }
      if (!policy.jev.reanalyzeOnCompaction) {
        // 压缩后只重推原包；segment 更新，下一段继续复用。
        this.cache.set(sessionId, { segment, packet: cached.packet })
        return { packet: cached.packet, segment, reused: true }
      }
    }

    const packet = this.selector.select({ sessionId, history, policy })
    if (!packet) return undefined
    this.cache.set(sessionId, { segment, packet })
    return { packet, segment, reused: false }
  }

  status(sessionId: string): { cached: boolean; segment?: string; packetId?: string } {
    const entry = this.cache.get(sessionId)
    return entry
      ? { cached: true, segment: entry.segment, packetId: entry.packet.id }
      : { cached: false }
  }
}

export function formatMemoryPacket(packet: MemoryPacket): string {
  const lines = [
    '## 框架推送的记忆（Jev 选择，不是用户发言）',
    `包 ${packet.id} · ${packet.entries.length} 条 · 策略 ${packet.strategy}`,
  ]
  for (const entry of packet.entries) {
    lines.push(
      '',
      `### ${entry.target}#${entry.entryId} [${entry.tag}] ${entry.title}`,
      entry.summary,
      entry.content && entry.content !== entry.summary ? `正文：${entry.content}` : '',
    )
  }
  return lines.filter(line => line !== '').join('\n')
}
