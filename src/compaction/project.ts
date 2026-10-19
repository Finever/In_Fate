/**
 * 压缩链与裁剪的投影索引。
 *
 * 只让链尾有效：被 supersedes 的节点不参与投影。
 *
 * @module if/compaction/project
 */

import type { Event } from '../core/events.ts'
import type { CompactionPayload, PruneItem, PrunePayload } from './types.ts'

export interface CompactionView {
  readonly eventId: string
  readonly payload: CompactionPayload
}

export interface CompactionIndex {
  readonly ranges: readonly { readonly start: number; readonly end: number; readonly payload: CompactionPayload }[]
  readonly pruned: ReadonlyMap<string, PruneItem>
}

/** 找当前有效的压缩节点（没有被别人取代的）。 */
export function effectiveCompactions(events: readonly Event[]): CompactionView[] {
  const nodes: CompactionView[] = []
  for (const event of events) {
    if (event.type !== 'context.compacted') continue
    nodes.push({ eventId: event.id, payload: event.payload as unknown as CompactionPayload })
  }

  const superseded = new Set<string>()
  for (const node of nodes) {
    const target = node.payload.supersedes
    if (typeof target === 'string' && target.length > 0) superseded.add(target)
  }

  // UUID 没有顺序意义，必须按事件在流里的位置排。
  const positions = new Map<string, number>()
  events.forEach((event, index) => positions.set(event.id, index))

  return nodes
    .filter(node => !superseded.has(node.eventId))
    .sort((a, b) => {
      const left = positions.get(a.payload.anchor.fromEventId) ?? 0
      const right = positions.get(b.payload.anchor.fromEventId) ?? 0
      return left - right
    })
}

/** 把锚点转成事件下标，顺便收集裁剪映射。 */
export function buildCompactionIndex(events: readonly Event[]): CompactionIndex {
  const positions = new Map<string, number>()
  events.forEach((event, index) => positions.set(event.id, index))

  const ranges = effectiveCompactions(events)
    .map(view => ({
      start: positions.get(view.payload.anchor.fromEventId) ?? -1,
      end: positions.get(view.payload.anchor.toEventId) ?? -1,
      payload: view.payload,
    }))
    .filter(range => range.start >= 0 && range.end >= range.start)

  const pruned = new Map<string, PruneItem>()
  for (const event of events) {
    if (event.type !== 'compaction.pruned') continue
    const payload = event.payload as unknown as PrunePayload

    if (Array.isArray(payload.items)) {
      for (const item of payload.items) pruned.set(item.eventId, item)
      continue
    }

    // 兼容旧事件：所有 id 共享一段 preview。
    for (const id of payload.eventIds ?? []) {
      pruned.set(String(id), {
        eventId: String(id),
        preview: payload.preview ?? '',
        ...(payload.ref ? { ref: payload.ref } : {}),
        beforeBytes: payload.beforeBytes ?? 0,
        afterBytes: payload.afterBytes ?? 0,
      })
    }
  }

  return { ranges, pruned }
}
