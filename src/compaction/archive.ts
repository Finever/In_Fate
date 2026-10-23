/**
 * 压缩后的段归档判定。
 *
 * 只归档：
 *   - 完全位于当前有效压缩链尾之前的段
 *   - 不含压缩事件、prune 事件或锚点事件的段
 *   - 不是当前活跃段的段
 *
 * 原文件不删除，只打 `.archived` 标记；read() 默认跳过，readAll() 仍能读。
 *
 * @module if/compaction/archive
 */

import type { EventStore } from '../core/store.ts'
import { findProjectionStart } from '../projections/history.ts'
import { buildCompactionIndex } from './project.ts'

const KEEP_TYPES = new Set(['context.compacted', 'compaction.pruned'])

export function archiveCompactedSegments(store: EventStore): string[] {
  const all = store.readAll()
  if (all.length === 0) return []

  const index = buildCompactionIndex(all)
  if (index.ranges.length === 0) return []

  const cut = findProjectionStart(all, index.ranges, false)
  if (!cut) return []

  const keepIds = new Set<string>()
  for (const range of index.ranges) {
    keepIds.add(range.payload.anchor.fromEventId)
    keepIds.add(range.payload.anchor.toEventId)
  }

  const archived: string[] = []
  let cursor = 0
  for (const segment of store.allSegments()) {
    const events = store.eventsOfSegment(segment)
    const end = cursor + events.length - 1
    const candidate = segment !== store.file
      && events.length > 0
      && end < cut.start
      && !events.some(event => KEEP_TYPES.has(event.type) || keepIds.has(event.id))

    if (candidate) {
      store.archiveSegment(segment)
      archived.push(segment)
    }
    cursor += events.length
  }

  return archived
}
