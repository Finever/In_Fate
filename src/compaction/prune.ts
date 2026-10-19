/**
 * 工具结果裁剪：超过阈值的文本换成预览 + spill 引用。
 *
 * 原事件不改；裁剪结果写成 compaction.pruned，投影时应用。
 *
 * @module if/compaction/prune
 */

import type { Event } from '../core/events.ts'
import type { SpillPolicy } from '../tools/spill.ts'
import type { PrunePayload } from './types.ts'

export interface Prunable {
  readonly eventId: string
  readonly text: string
  readonly bytes: number
}

export function findPrunable(events: readonly Event[], thresholdBytes: number): Prunable[] {
  const already = new Set<string>()
  for (const event of events) {
    if (event.type !== 'compaction.pruned') continue
    for (const id of event.payload.eventIds as readonly string[] ?? []) already.add(String(id))
  }

  const out: Prunable[] = []
  for (const event of events) {
    if (event.type !== 'tool.result') continue
    if (already.has(event.id)) continue
    const text = String(event.payload.text ?? '')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= thresholdBytes) continue
    out.push({ eventId: event.id, text, bytes })
  }
  return out
}

export function buildPrunePayload(
  items: readonly Prunable[],
  spill: SpillPolicy,
): PrunePayload {
  const texts = items.map(item => item.text).join('\n\n---\n\n')
  const spilled = spill.apply(texts)
  return {
    eventIds: items.map(item => item.eventId),
    ref: spilled.ref,
    preview: spilled.text.slice(0, spill.previewChars),
    beforeBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    afterBytes: Buffer.byteLength(spilled.text, 'utf8'),
  }
}
