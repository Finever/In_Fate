import type { ContextSection, PipelineContext } from './types.ts'
import type { MemoryPushService } from '../memory/push.ts'
import { formatMemoryPacket } from '../memory/push.ts'

export function memoryPushSection(
  id: string,
  push: MemoryPushService,
  priority = 95,
): ContextSection {
  return {
    id,
    layer: 'dynamic',
    priority,
    render: (context: PipelineContext) => {
      const selected = push.packetFor(context.sessionId, context.history)
      if (!selected) return
      const text = formatMemoryPacket(selected.packet)
      return {
        text,
        meta: {
          packetId: selected.packet.id,
          segment: selected.segment,
          reused: selected.reused,
          entries: selected.packet.entries.length,
          bytes: Buffer.byteLength(text, 'utf8'),
        },
      }
    },
  }
}
