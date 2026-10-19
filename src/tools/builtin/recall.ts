/**
 * recall：按压缩锚点回查原始事件。
 *
 * 压缩摘要只留骨架；需要细节时按 anchor 取原文，不靠模型记忆。
 *
 * @module if/tools/builtin/recall
 */

import type { EventStore } from '../../core/store.ts'
import type { ToolDefinition, ToolResult } from '../types.ts'

export interface RecallInput {
  readonly fromEventId: string
  readonly toEventId: string
  readonly query?: string
  readonly limit?: number
}

export function createRecallTool(store: EventStore): ToolDefinition {
  return {
    name: 'recall',
    description: '按压缩锚点回查原始事件。摘要不够时用它拿原文。',
    inputSchema: {
      type: 'object',
      properties: {
        fromEventId: { type: 'string' },
        toEventId: { type: 'string' },
        query: { type: 'string', description: '只返回包含该词的片段' },
        limit: { type: 'number', minimum: 1, maximum: 200 },
      },
      required: ['fromEventId', 'toEventId'],
      additionalProperties: false,
    },
    meta: { readOnly: true },

    async run(args): Promise<ToolResult> {
      const input = args as RecallInput
      const events = store.read()
      const start = events.findIndex(event => event.id === input.fromEventId)
      const end = events.findIndex(event => event.id === input.toEventId)

      if (start < 0 || end < start) {
        return { text: 'anchor not found', isError: true }
      }

      let slice = events.slice(start, end + 1)
      if (input.query) {
        const query = input.query
        slice = slice.filter(event => JSON.stringify(event.payload).includes(query))
      }

      const total = slice.length
      const limit = input.limit ?? 50
      const text = slice
        .slice(0, limit)
        .map(event => `[${event.type}] ${JSON.stringify(event.payload)}`)
        .join('\n')

      return {
        text: text || '（没有匹配的原文）',
        structured: { total, returned: Math.min(total, limit) },
        bytes: Buffer.byteLength(text, 'utf8'),
        encoding: 'utf-8',
      }
    },
  }
}
