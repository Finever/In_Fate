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
