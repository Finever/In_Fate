import type { MemoryAccess } from './access.ts'
import type { MemoryPolicyStore } from './policy.ts'
import type { MemoryProposalStore } from './proposals.ts'
import type { MemorySearchIndex } from './search-index.ts'
import type { SemanticMemoryIndex } from './semantic-index.ts'
import type { MemorySpaceAccess } from './space-access.ts'
import { spaceDir, type MemorySpaceStore } from './space.ts'
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

/**
 * 共享工具只认公开 detail；下划线域是私域，不能被 memory_read 之类的直读绕过。
 */
function sharedTarget(value: string): string {
  const body = value.startsWith('detail:') ? value.slice('detail:'.length) : ''
  const segments = body.split('/')
  if (
    segments.length < 2
    || segments.some(part => !part || part.startsWith('_') || part.startsWith('.'))
  ) {
    throw new Error(`private memory target is not accessible through shared tools: ${value}`)
  }
  return value
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
  readonly semanticIndex?: SemanticMemoryIndex
  readonly spaces?: MemorySpaceStore
  readonly spaceAccess?: MemorySpaceAccess
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
        reanalyzeOnCompaction: true,
      },
      rag: { topK: 20 },
      maxEntries: 12,
      maxBytes: 24_000,
    }

  const canWrite = (sessionId: string): boolean =>
    deps.access.canWrite(sessionId, 'shared')
    || (policyOf(sessionId).write.approval === 'off'
      && deps.access.canPropose(sessionId, 'shared'))

  type SpaceResolution =
    | { readonly ok: true; readonly dir: string }
    | { readonly ok: false; readonly error: string }

  type SpaceAction = 'read' | 'write' | 'propose'

  const resolveSpace = (
    sessionId: string,
    spaceId: string,
    action: SpaceAction,
  ): SpaceResolution => {
    const space = deps.spaces?.get(spaceId)
    if (!space) return { ok: false, error: `unknown memory space: ${spaceId}` }
    // write 的最终判断交给调用方（policy approval off 时 worker 也能直写）；
    // 这里只确认“看得见这个空间”，propose/read 则按对应动作校验。
    const required = action === 'write' ? 'read' : action
    if (!deps.spaceAccess?.can(sessionId, spaceId, required)) {
      return { ok: false, error: `memory space ${action} not granted: ${spaceId}` }
    }
    return { ok: true, dir: spaceDir(space) }
  }

  const canWriteSpace = (sessionId: string, spaceId: string): boolean =>
    deps.spaceAccess?.can(sessionId, spaceId, 'write') === true
    || (policyOf(sessionId).write.approval === 'off'
      && deps.spaceAccess?.can(sessionId, spaceId, 'propose') === true)

  /** space 内 target：已带空间目录就原样，否则自动加前缀。 */
  const targetInSpace = (dir: string, value: string): string => {
    const body = value.startsWith('detail:') ? value.slice('detail:'.length) : value
    const segments = body.split('/').filter(part => part.length > 0)
    if (segments.length === 0 || segments.some(part => part === '..' || part.startsWith('.'))) {
      throw new Error(`invalid memory target in space: ${value}`)
    }
    const joined = segments[0] === dir ? segments.join('/') : [dir, ...segments].join('/')
    return `detail:${joined}`
  }

  /** 解析 space + target；不传 space 就退回共享域（下划线目录仍禁止）。
   *  目标若落在注册过的空间目录里，也按那个空间的 ACL 校验，并带上 spaceId。 */
  const resolveTarget = (
    sessionId: string,
    action: SpaceAction,
    value: string,
    spaceId: string | undefined,
  ): { target: string; spaceId?: string } | { error: string } => {
    if (spaceId !== undefined && spaceId.length > 0) {
      const resolved = resolveSpace(sessionId, spaceId, action)
      if (!resolved.ok) return { error: resolved.error }
      try {
        return { target: targetInSpace(resolved.dir, value), spaceId }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
    try {
      const target = sharedTarget(value)
      const space = deps.spaces?.list().find(item => spaceDir(item) === topSegmentOf(target))
      if (space) {
        const resolved = resolveSpace(sessionId, space.id, action)
        if (!resolved.ok) return { error: resolved.error }
        return { target, spaceId: space.id }
      }
      return { target }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const topSegmentOf = (value: string): string => {
    const body = value.startsWith('detail:') ? value.slice('detail:'.length) : value
    return body.split('/')[0] ?? ''
  }

  /** 检索命中过滤：注册过的空间看空间可读性；没登记的 `_` 目录一律不推；
   *  其余共享域看 shared 权限。 */
  const hitReadable = (sessionId: string, target: string): boolean => {
    const top = topSegmentOf(target)
    const space = deps.spaces?.list().find(item => spaceDir(item) === top)
    if (space) return deps.spaceAccess?.can(sessionId, space.id, 'read') === true
    if (top.startsWith('_')) return false
    return deps.access.canRead(sessionId, 'shared')
  }

  const spaceIdOfInput = (input: Record<string, unknown>): string | undefined => {
    const value = input.space
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  const search: ToolDefinition = {
    name: 'memory_search',
    description: '在共享 detail 记忆里搜索内容；只返回命中预览。带 space 参数可搜对应记忆空间。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
        space: { type: 'string', description: '记忆空间 id；不传只搜共享域' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    meta: { readOnly: true },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      const input = args as { query: string; limit?: number; space?: string }
      const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 100))
      let scopedDir: string | undefined
      if (input.space !== undefined && input.space.length > 0) {
        const resolved = resolveSpace(context.sessionId, input.space, 'read')
        if (!resolved.ok) return denied(resolved.error)
        scopedDir = resolved.dir
      } else if (!deps.access.canRead(context.sessionId, 'shared')) {
        return denied('memory read not granted')
      }
      // 索引里可能混着私域条目，先多取一些再按权限过滤。
      const fetchLimit = Math.min(limit * 4, 100)
      let hits
      try {
        const semanticReady = deps.semanticIndex?.status().ready
        hits = semanticReady && deps.semanticIndex
          ? await deps.semanticIndex.search(input.query, { limit: fetchLimit })
          : deps.searchIndex
            ? deps.searchIndex.search(input.query, { limit: fetchLimit })
            : deps.store.search(input.query, fetchLimit, { includePrivate: true })
      } catch {
        hits = deps.searchIndex
          ? deps.searchIndex.search(input.query, { limit: fetchLimit })
          : deps.store.search(input.query, fetchLimit, { includePrivate: true })
      }
      const filtered = hits
        .filter(hit => hitReadable(context.sessionId, hit.target))
        .filter(hit => scopedDir === undefined || topSegmentOf(hit.target) === scopedDir)
        .slice(0, limit)
      return {
        text: filtered.map(hit => `${hit.target}#${hit.id} [${hit.tag}] ${hit.preview}`).join('\n')
          || '（没有命中）',
        structured: { hits: filtered },
      }
    },
  }

  const read: ToolDefinition = {
    name: 'memory_read',
    description: '读取一个 detail 记忆文件，或其中一条 entry。带 space 参数可读对应记忆空间。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'detail:<domain>/<file>' },
        id: { type: 'string' },
        space: { type: 'string', description: '记忆空间 id；不传只读共享域' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    meta: { readOnly: true },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      const input = args as { target: string; id?: string; space?: string }
      const resolved = resolveTarget(context.sessionId, 'read', input.target, input.space)
      if ('error' in resolved) return denied(resolved.error)
      if (resolved.spaceId === undefined
        && !deps.access.canRead(context.sessionId, 'shared')) {
        return denied('memory read not granted')
      }
      const doc = deps.store.read(resolved.target)
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
    description: '向共享 detail 追加一条记忆；带 space 参数写入对应记忆空间。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'detail:<domain>/<file>' },
        content: { type: 'string' },
        tag: { type: 'string', enum: ['确信', '可信', '有疑'] },
        at: { type: 'string' },
        quotes: { type: 'array', items: QUOTE_SCHEMA },
        introduction: { type: 'string', description: '新文件必填' },
        space: { type: 'string', description: '记忆空间 id；不传写共享域' },
      },
      required: ['target', 'content', 'tag'],
      additionalProperties: false,
    },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      const input = args as Record<string, unknown>
      const resolved = resolveTarget(
        context.sessionId,
        'write',
        String(input.target),
        spaceIdOfInput(input),
      )
      if ('error' in resolved) return denied(resolved.error)
      const allowed = resolved.spaceId !== undefined
        ? canWriteSpace(context.sessionId, resolved.spaceId)
        : canWrite(context.sessionId)
      if (!allowed) {
        return denied(resolved.spaceId !== undefined
          ? `memory space write not granted: ${resolved.spaceId}`
          : 'memory write not granted; use memory_propose or turn write approval off')
      }
      const entry = await deps.store.add(resolved.target, entryInput(input))
      return {
        text: `已写入 ${resolved.target}#${entry.id}`,
        structured: entry,
      }
    },
  }

  const update: ToolDefinition = {
    name: 'memory_update',
    description: '更新共享 detail 的一条记忆；带 space 参数更新对应记忆空间。',
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
        space: { type: 'string', description: '记忆空间 id；不传更新共享域' },
      },
      required: ['target', 'id'],
      additionalProperties: false,
    },
    async run(args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      const input = args as Record<string, unknown>
      const resolved = resolveTarget(
        context.sessionId,
        'write',
        String(input.target),
        spaceIdOfInput(input),
      )
      if ('error' in resolved) return denied(resolved.error)
      const allowed = resolved.spaceId !== undefined
        ? canWriteSpace(context.sessionId, resolved.spaceId)
        : canWrite(context.sessionId)
      if (!allowed) {
        return denied(resolved.spaceId !== undefined
          ? `memory space write not granted: ${resolved.spaceId}`
          : 'memory write not granted; use memory_propose or turn write approval off')
      }
      const entry = await deps.store.update(resolved.target, String(input.id), {
        ...(input.content !== undefined ? { content: String(input.content) } : {}),
        ...(input.tag !== undefined ? { tag: parseTag(input.tag) } : {}),
        ...(input.at !== undefined ? { at: input.at === null ? null : String(input.at) } : {}),
        ...(Array.isArray(input.quotes) ? { quotes: input.quotes as MemoryQuote[] } : {}),
        ...(input.expectedRevTime !== undefined
          ? { expectedRevTime: String(input.expectedRevTime) }
          : {}),
      })
      return {
        text: `已更新 ${resolved.target}#${entry.id}`,
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
        space: { type: 'string', description: '记忆空间 id；不传提议共享域' },
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

      const resolved = resolveTarget(
        context.sessionId,
        'propose',
        target,
        spaceIdOfInput(input),
      )
      if ('error' in resolved) return denied(resolved.error)
      if (resolved.spaceId === undefined
        && !deps.access.canPropose(context.sessionId, 'shared')) {
        return denied('memory propose not granted')
      }
      const proposal = deps.proposals.propose({
        target: resolved.target,
        sourceSession: context.sessionId,
        entry: entryInput(input),
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      })
      return {
        text: `已提交记忆提议 ${proposal.proposalId} → ${resolved.target}`,
        structured: proposal,
      }
    },
  }

  const kindText: Record<string, string> = {
    private: '私域',
    shared: '共有',
    user: '用户空间',
  }

  const spacesTool: ToolDefinition = {
    name: 'memory_spaces',
    description: '列出当前会话可见的记忆空间与权限；读写它们时给别的记忆工具传 space 参数。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    meta: { readOnly: true },
    async run(_args, context) {
      if (policyOf(context.sessionId).mode === 'off') {
        return denied('memory is turned off for this session')
      }
      const described = deps.spaceAccess?.describe(context.sessionId) ?? []
      if (described.length === 0) {
        return { text: '（没有可见的记忆空间）', structured: { spaces: [] } }
      }
      const text = described.map(space => {
        const bits = [
          `- ${space.id}（${kindText[space.kind] ?? space.kind}，角色 ${space.role}`,
          space.autoPush ? '，自动推送' : '',
          space.description ? `）${space.description}` : '）',
        ]
        return bits.join('')
      }).join('\n')
      return { text, structured: { spaces: described } }
    },
  }

  return [search, read, add, update, propose, spacesTool]
}
