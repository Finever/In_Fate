/**
 * recall：按压缩锚点回查原文。
 *
 * 两种锚点：
 *   - 事件区间：fromEventId..toEventId（会话流）
 *   - 流水地址：logAddr（记忆库 log）
 *
 * @module if/tools/builtin/recall
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStore } from '../../core/store.ts'
import { readLog } from '../../memory/log.ts'
import { parseAddress } from '../../memory/quote.ts'
import type { ToolDefinition, ToolResult } from '../types.ts'

export interface RecallInput {
  readonly fromEventId?: string
  readonly toEventId?: string
  readonly logAddr?: string
  readonly query?: string
  readonly limit?: number
}

export interface RecallOptions {
  readonly memoryLogRoot?: string
}

/** 允许按会话取 store：App 里每个会话一份事件文件。 */
export type RecallStore = EventStore | ((sessionId: string) => EventStore)

export function createRecallTool(store: RecallStore, options: RecallOptions = {}): ToolDefinition {
  const storeOf = (sessionId: string): EventStore =>
    typeof store === 'function' ? store(sessionId) : store

  return {
    name: 'recall',
    description: '按压缩锚点回查原文。给 logAddr，或给 fromEventId + toEventId。',
    inputSchema: {
      type: 'object',
      properties: {
        fromEventId: { type: 'string' },
        toEventId: { type: 'string' },
        logAddr: { type: 'string', description: '记忆库流水地址：年-月-日-会话id-n' },
        query: { type: 'string', description: '只返回包含该词的片段' },
        limit: { type: 'number', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    meta: { readOnly: true },

    async run(args, context): Promise<ToolResult> {
      const input = args as RecallInput
      const limit = input.limit ?? 50

      if (input.logAddr) {
        if (!options.memoryLogRoot) {
          return { text: 'memoryLogRoot is not configured', isError: true }
        }
        const address = parseAddress(input.logAddr)
        const [year, month] = address.date.split('-')
        const file = join(
          options.memoryLogRoot,
          'log',
          year!,
          month!,
          address.date,
          `${address.session}.jsonl`,
        )
        if (!existsSync(file)) return { text: `log not found: ${file}`, isError: true }

        const rows = readLog(file).filter(row => row.n === address.n)
        let text = rows.map(row => JSON.stringify(row)).join('\n')
        if (input.query) {
          text = text.split('\n').filter(line => line.includes(input.query!)).join('\n')
        }
        return {
          text: text || '（该轮没有匹配的记录）',
          structured: { source: 'log', address: input.logAddr, rows: rows.length },
          bytes: Buffer.byteLength(text, 'utf8'),
          encoding: 'utf-8',
        }
      }

      if (!input.fromEventId || !input.toEventId) {
        return { text: 'need logAddr or fromEventId + toEventId', isError: true }
      }

      const events = storeOf(context.sessionId).read()
      const start = events.findIndex(event => event.id === input.fromEventId)
      const end = events.findIndex(event => event.id === input.toEventId)
      if (start < 0 || end < start) return { text: 'anchor not found', isError: true }

      let slice = events.slice(start, end + 1)
      if (input.query) {
        const query = input.query
        slice = slice.filter(event => JSON.stringify(event.payload).includes(query))
      }

      const total = slice.length
      const text = slice
        .slice(0, limit)
        .map(event => `[${event.type}] ${JSON.stringify(event.payload)}`)
        .join('\n')

      return {
        text: text || '（没有匹配的原文）',
        structured: { source: 'events', total, returned: Math.min(total, limit) },
        bytes: Buffer.byteLength(text, 'utf8'),
        encoding: 'utf-8',
      }
    },
  }
}
