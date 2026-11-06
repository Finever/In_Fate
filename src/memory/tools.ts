/**
 * 记忆工具：搜索、读取、直写、更新、提议。
 *
 * 工具本身不判断“主/子”；只检查当前 session 的 MemoryGrant。
 *
 * @module if/memory/tools
 */

import type { MemoryAccess } from './access.ts'
import type { MemoryPolicyStore } from './policy.ts'
import type { MemoryProposalStore } from './proposals.ts'
import type { MemorySearchIndex } from './search-index.ts'
import type { MemoryAddInput, MemoryQuote, MemoryTag, MemoryStore } from './store.ts'
import type { ToolDefinition, ToolResult } from '../tools/types.ts'

const QUOTE_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    at: { type: 'string' },
    tag: { type: 'array', items: { type: 'string' } },
    'log-addr': { type: 'string' },
  },
  required: ['say', 'log-addr'],
  additionalProperties: false,
}

function denied(text: string): ToolResult {
  return { text, isError: true }
}

function parseTag(value: unknown): MemoryTag {
  if (value === '确信' || value === '可信' || value === '有疑') return value
  throw new Error(`invalid memory tag: ${String(value)}`)
}

function entryInput(args: Record<string, unknown>): MemoryAddInput {
  return {
    content: String(args.content ?? ''),
    tag: parseTag(args.tag),
    ...(args.at !== undefined ? { at: args.at === null ? null : String(args.at) } : {}),
    ...(Array.isArray(args.quotes) ? { quotes: args.quotes as MemoryQuote[] } : {}),
    ...(typeof args.introduction === 'string' ? { introduction: args.introduction } : {}),
  }
}

export function createMemoryTools(deps: {
  readonly store: MemoryStore
  readonly access: MemoryAccess
  readonly proposals: MemoryProposalStore
  readonly policy?: MemoryPolicyStore
  readonly searchIndex?: MemorySearchIndex
}): ToolDefinition[] {
  const policyOf = (sessionId: string) =>
    deps.policy?.resolve(sessionId) ?? {
      mode: 'rag-tool' as const,
      scope: 'agent' as const,
      write: { approval: 'required' as const },
      jev: {
        enabled: 'off' as const,
        backend: 'local' as const,
        scope: 'agent' as const,
        reanalyzeOnCompaction: false,
      },
      rag: { topK: 20 },
      maxEntries: 12,
      maxBytes: 24_000,
    }

  const canWrite = (sessionId: string): boolean =>
    deps.access.canWrite(sessionId, 'shared')
    || policyOf(sessionId).write.approval === 'off'

  const search: ToolDefinition = {
    name: 'memory_search',
    description: '在共享 detail 记忆里搜索内容；只返回命中预览，不返回全文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    meta: { readOnly: true },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      if (!deps.access.canRead(context.sessionId, 'shared')) {
        return denied('memory read not granted')
      }
      const input = args as { query: string; limit?: number }
      let hits
      try {
        hits = deps.searchIndex
          ? deps.searchIndex.search(input.query, { limit: input.limit ?? 20 })
          : deps.store.search(input.query, input.limit ?? 20)
      } catch {
        hits = deps.store.search(input.query, input.limit ?? 20)
      }
      return {
        text: hits.map(hit => `${hit.target}#${hit.id} [${hit.tag}] ${hit.preview}`).join('\n')
          || '（没有命中）',
        structured: { hits },
      }
    },
  }

  const read: ToolDefinition = {
    name: 'memory_read',
    description: '读取一个 detail 记忆文件，或其中一条 entry。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'detail:<domain>/<file>' },
        id: { type: 'string' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    meta: { readOnly: true },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      if (!deps.access.canRead(context.sessionId, 'shared')) {
        return denied('memory read not granted')
      }
      const input = args as { target: string; id?: string }
      const doc = deps.store.read(input.target)
      if (input.id) {
        const entry = doc.entries.find(item => item.id === input.id)
        if (!entry) return { text: `memory entry not found: ${input.id}`, isError: true }
        return { text: JSON.stringify(entry, null, 2), structured: entry }
      }
      return {
        text: JSON.stringify({
          project: doc.project,
          filename: doc.filename,
          introduction: doc.introduction,
          entries: doc.entries,
        }, null, 2),
        structured: doc,
      }
    },
  }

  const add: ToolDefinition = {
    name: 'memory_add',
    description: '向共享 detail 追加一条记忆。必须有 write:shared 能力。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'detail:<domain>/<file>' },
        content: { type: 'string' },
        tag: { type: 'string', enum: ['确信', '可信', '有疑'] },
        at: { type: 'string' },
        quotes: { type: 'array', items: QUOTE_SCHEMA },
        introduction: { type: 'string', description: '新文件必填' },
      },
      required: ['target', 'content', 'tag'],
      additionalProperties: false,
    },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      if (!canWrite(context.sessionId)) {
        return denied('memory write not granted; use memory_propose or turn write approval off')
      }
      const input = args as Record<string, unknown>
      const entry = await deps.store.add(String(input.target), entryInput(input))
      return {
        text: `已写入 ${String(input.target)}#${entry.id}`,
        structured: entry,
      }
    },
  }

  const update: ToolDefinition = {
    name: 'memory_update',
    description: '更新共享 detail 的一条记忆。必须有 write:shared 能力。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        id: { type: 'string' },
        content: { type: 'string' },
        tag: { type: 'string', enum: ['确信', '可信', '有疑'] },
        at: { type: 'string' },
        quotes: { type: 'array', items: QUOTE_SCHEMA },
        expectedRevTime: { type: 'string' },
      },
      required: ['target', 'id'],
      additionalProperties: false,
    },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      if (!canWrite(context.sessionId)) {
        return denied('memory write not granted; use memory_propose or turn write approval off')
      }
      const input = args as Record<string, unknown>
      const entry = await deps.store.update(String(input.target), String(input.id), {
        ...(input.content !== undefined ? { content: String(input.content) } : {}),
        ...(input.tag !== undefined ? { tag: parseTag(input.tag) } : {}),
        ...(input.at !== undefined ? { at: input.at === null ? null : String(input.at) } : {}),
        ...(Array.isArray(input.quotes) ? { quotes: input.quotes as MemoryQuote[] } : {}),
        ...(input.expectedRevTime !== undefined
          ? { expectedRevTime: String(input.expectedRevTime) }
          : {}),
      })
      return {
        text: `已更新 ${String(input.target)}#${entry.id}`,
        structured: entry,
      }
    },
  }

  const propose: ToolDefinition = {
    name: 'memory_propose',
    description: '提议一条共享记忆，等待有写权限的会话或用户接受。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        content: { type: 'string' },
        tag: { type: 'string', enum: ['确信', '可信', '有疑'] },
        at: { type: 'string' },
        quotes: { type: 'array', items: QUOTE_SCHEMA },
        introduction: { type: 'string' },
        reason: { type: 'string' },
        section: { type: 'string', description: 'identity 的二级标题' },
        mode: { type: 'string', enum: ['replace-section', 'append'] },
      },
      required: ['target', 'content'],
      additionalProperties: false,
    },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      const input = args as Record<string, unknown>
      const target = String(input.target)
      if (target.startsWith('identity:')) {
        if (!deps.access.canPropose(context.sessionId, 'identity')) {
          return denied('identity propose not granted')
        }
        const file = target.slice('identity:'.length)
        if (file !== 'SOUL' && file !== 'USER' && file !== 'FACT') {
          return { text: `unknown identity file: ${file}`, isError: true }
        }
        const section = typeof input.section === 'string' ? input.section : ''
        if (section.trim().length === 0) {
          return { text: 'identity proposal needs section', isError: true }
        }
        const proposal = deps.proposals.proposeIdentity({
          target,
          sourceSession: context.sessionId,
          identity: {
            file,
            section,
            content: String(input.content ?? ''),
            mode: input.mode === 'append' ? 'append' : 'replace-section',
          },
          ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
        })
        return {
          text: `已提交身份记忆提议 ${proposal.proposalId}`,
          structured: proposal,
        }
      }

      if (!deps.access.canPropose(context.sessionId, 'shared')) {
        return denied('memory propose not granted')
      }
      const proposal = deps.proposals.propose({
        target,
        sourceSession: context.sessionId,
        entry: entryInput(input),
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      })
      return {
        text: `已提交记忆提议 ${proposal.proposalId}`,
        structured: proposal,
      }
    },
  }

  return [search, read, add, update, propose]
}
