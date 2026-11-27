import type { Event } from '../core/events.ts'
import type { SpillPolicy } from '../tools/spill.ts'
import type { PruneItem, PrunePayload } from './types.ts'

export interface Prunable {
  readonly eventId: string
  readonly text: string
  readonly bytes: number
}

export function findPrunable(events: readonly Event[], thresholdBytes: number): Prunable[] {
  const already = new Set<string>()
  for (const event of events) {
    if (event.type !== 'compaction.pruned') continue
    const payload = event.payload as unknown as PrunePayload
    if (Array.isArray(payload.items)) {
      for (const item of payload.items) already.add(item.eventId)
    } else {
      for (const id of payload.eventIds ?? []) already.add(String(id))
    }
  }

  const out: Prunable[] = []
  for (const event of events) {
    if (event.type !== 'tool.result') continue
    if (already.has(event.id)) continue

    const text = String(event.payload.text ?? '')
    const structured = event.payload.structured
    const bytes = Buffer.byteLength(JSON.stringify(event.payload), 'utf8')
    if (bytes <= thresholdBytes) continue

    const content = text.length > 0
      ? text
      : structured !== undefined
        ? JSON.stringify(structured)
        : ''

    out.push({ eventId: event.id, text: content, bytes })
  }
  return out
}

export function buildPrunePayload(
  items: readonly Prunable[],
  spill: SpillPolicy,
): PrunePayload {
  const pruned: PruneItem[] = items.map(item => {
    const spilled = spill.apply(item.text)
    return {
      eventId: item.eventId,
      preview: spilled.text.slice(0, spill.previewChars),
      ...(spilled.ref ? { ref: spilled.ref } : {}),
      beforeBytes: item.bytes,
      afterBytes: Buffer.byteLength(spilled.text, 'utf8'),
    }
  })

  return { items: pruned }
}
