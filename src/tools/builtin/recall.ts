import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BlobStore } from '../../core/blobs.ts'
import { assertWithin } from '../../core/safe-path.ts'
import type { EventStore } from '../../core/store.ts'
import { readLog } from '../../memory/log.ts'
import { parseAddress } from '../../memory/quote.ts'
import type { FileSpillStore } from '../spill.ts'
import type { ToolDefinition, ToolResult } from '../types.ts'

export interface RecallInput {
  readonly fromEventId?: string
  readonly toEventId?: string
  readonly logAddr?: string
  readonly ref?: string
  readonly field?: 'text' | 'structured'
  readonly agentRequestId?: string
  readonly offset?: number
  readonly limit?: number
  readonly query?: string
}

export interface RecallOptions {
  readonly memoryLogRoot?: string
  readonly blobs?: BlobStore
  readonly spill?: FileSpillStore
  /** 读子 agent 自己的流；由 App 注入 */
  readonly agentStore?: (requestId: string) => EventStore
}

/** 允许按会话取 store：App 里每个会话一份事件文件。 */
export type RecallStore = EventStore | ((sessionId: string) => EventStore)

export function createRecallTool(store: RecallStore, options: RecallOptions = {}): ToolDefinition {
  const storeOf = (sessionId: string): EventStore =>
    typeof store === 'function' ? store(sessionId) : store

  return {
    name: 'recall',
    description: '按压缩锚点或 blob/spill ref 回查原文。给 ref 取卸载全文；或给 logAddr、fromEventId + toEventId。',
    inputSchema: {
      type: 'object',
      properties: {
        fromEventId: { type: 'string' },
        toEventId: { type: 'string' },
        logAddr: { type: 'string', description: '记忆库流水地址：年-月-日-会话id-n' },
        ref: { type: 'string', description: 'blob:<sha256> 或 spill:<sha1>' },
        field: { type: 'string', enum: ['text', 'structured'], description: '默认 text' },
        agentRequestId: { type: 'string', description: '子 agent 请求 id；读它自己的事件流' },
        offset: { type: 'number', minimum: 0, description: '字符偏移（blob/spill）' },
        limit: { type: 'number', minimum: 1, maximum: 200000 },
        query: { type: 'string', description: '只返回包含该词的片段' },
      },
      additionalProperties: false,
    },
    meta: { readOnly: true },

    async run(args, context): Promise<ToolResult> {
      const input = args as RecallInput
      const limit = input.limit ?? 50

      if (input.agentRequestId) {
        if (!options.agentStore) return { text: 'agent store is not configured', isError: true }
        const events = options.agentStore(input.agentRequestId).read()
        const size = Math.min(Math.max(1, Math.floor(input.limit ?? 100)), 200)
        const text = events
          .slice(0, size)
          .map(event => `[${event.type}] ${JSON.stringify(event.payload)}`)
          .join('\n')
        return {
          text: text || '（子 agent 流为空）',
          structured: {
            source: 'agent',
            requestId: input.agentRequestId,
            total: events.length,
            returned: Math.min(events.length, size),
          },
          bytes: Buffer.byteLength(text, 'utf8'),
          encoding: 'utf-8',
        }
      }

      if (input.ref) {
        const offset = Math.max(0, Math.floor(input.offset ?? 0))
        const size = Math.max(1, Math.floor(input.limit ?? 20_000))
        const field = input.field ?? 'text'

        if (input.ref.startsWith('blob:')) {
          if (!options.blobs) return { text: 'blob store is not configured', isError: true }
          const slice = options.blobs.readText(input.ref, {
            offset,
            limit: size,
            encoding: 'utf-8',
          })
          return {
            text: slice.text,
            structured: {
              source: 'blob',
              ref: input.ref,
              field,
              offset: slice.offset,
              totalChars: slice.totalChars,
              eof: slice.eof,
            },
            bytes: slice.bytes,
            encoding: 'utf-8',
          }
        }

        if (input.ref.startsWith('spill:')) {
          if (!options.spill) return { text: 'spill store is not configured', isError: true }
          const full = options.spill.get(input.ref)
          const start = Math.min(full.length, offset)
          const text = full.slice(start, start + size)
          return {
            text,
            structured: {
              source: 'spill',
              ref: input.ref,
              field,
              offset: start,
              totalChars: full.length,
              eof: start + text.length >= full.length,
            },
            bytes: Buffer.byteLength(text, 'utf8'),
            encoding: 'utf-8',
          }
        }

        return { text: `unsupported ref: ${input.ref}`, isError: true }
      }

      if (input.logAddr) {
        if (!options.memoryLogRoot) {
          return { text: 'memoryLogRoot is not configured', isError: true }
        }
        const address = parseAddress(input.logAddr)
        const [year, month] = address.date.split('-')
        const file = assertWithin(
          options.memoryLogRoot,
          join(
            options.memoryLogRoot,
            'log',
            year!,
            month!,
            address.date,
            `${address.session}.jsonl`,
          ),
          'logAddr',
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
        .slice(0, Math.min(limit, 200))
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
