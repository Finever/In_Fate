/**
 * 记忆策略：全局 → agent → session 三级覆盖。
 *
 * 只描述“怎么用记忆”，不碰具体条目；写盘是普通 JSON，改错可回退。
 *
 * @module if/memory/policy
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type MemoryMode = 'off' | 'rag-tool' | 'jev-push'
export type MemoryScope = 'session' | 'agent' | 'domain' | 'target' | 'all'
export type MemoryWriteApproval = 'required' | 'off'
export type JevEnabled = 'off' | 'once' | 'always'

export interface MemoryWritePolicy {
  readonly approval?: MemoryWriteApproval
}

export interface JevPolicy {
  /** off = 不启用 Jev；once = 每段上下文第一次 + 压缩后；always = 常驻 */
  readonly enabled?: JevEnabled
  /** local = IF 自己的本地运行时；api = 外部服务 */
  readonly backend?: 'local' | 'api'
  readonly scope?: MemoryScope
  readonly scopeValue?: string
  /** 压缩后是否重新分析；默认 false，只重推缓存包 */
  readonly reanalyzeOnCompaction?: boolean
}

export interface RagPolicy {
  /** 检索候选上限；最终 packet 预算由 maxEntries/maxBytes 控 */
  readonly topK?: number
}

export interface MemoryPolicy {
  readonly mode?: MemoryMode
  readonly scope?: MemoryScope
  readonly scopeValue?: string
  readonly write?: MemoryWritePolicy
  readonly jev?: JevPolicy
  readonly rag?: RagPolicy
  readonly maxEntries?: number
  readonly maxBytes?: number
}

export interface ResolvedMemoryPolicy {
  readonly mode: MemoryMode
  readonly scope: MemoryScope
  readonly scopeValue?: string
  readonly write: { readonly approval: MemoryWriteApproval }
  readonly jev: {
    readonly enabled: JevEnabled
    readonly backend: 'local' | 'api'
    readonly scope: MemoryScope
    readonly scopeValue?: string
    readonly reanalyzeOnCompaction: boolean
  }
  readonly rag: { readonly topK: number }
  readonly maxEntries: number
  readonly maxBytes: number
}

export const DEFAULT_MEMORY_POLICY: ResolvedMemoryPolicy = {
  mode: 'rag-tool',
  scope: 'agent',
  write: { approval: 'required' },
  jev: {
    enabled: 'off',
    backend: 'local',
    scope: 'agent',
    reanalyzeOnCompaction: true,
  },
  rag: { topK: 20 },
  maxEntries: 12,
  maxBytes: 24_000,
}

export interface MemoryPolicyDocument {
  readonly version: 1
  default: MemoryPolicy
  agents: Record<string, MemoryPolicy>
  sessions: Record<string, MemoryPolicy>
}

function mergeWrite(
  base: MemoryPolicy['write'],
  patch: MemoryPolicy['write'],
): MemoryPolicy['write'] | undefined {
  if (!base && !patch) return undefined
  return { ...(base ?? {}), ...(patch ?? {}) }
}

function mergeJev(
  base: MemoryPolicy['jev'],
  patch: MemoryPolicy['jev'],
): MemoryPolicy['jev'] | undefined {
  if (!base && !patch) return undefined
  return { ...(base ?? {}), ...(patch ?? {}) }
}

function mergeRag(
  base: MemoryPolicy['rag'],
  patch: MemoryPolicy['rag'],
): MemoryPolicy['rag'] | undefined {
  if (!base && !patch) return undefined
  return { ...(base ?? {}), ...(patch ?? {}) }
}

function mergePolicy(base: MemoryPolicy, patch: MemoryPolicy | undefined): MemoryPolicy {
  if (!patch) return base
  return {
    ...base,
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
    ...(patch.scopeValue !== undefined ? { scopeValue: patch.scopeValue } : {}),
    ...(mergeWrite(base.write, patch.write) ? { write: mergeWrite(base.write, patch.write) } : {}),
    ...(mergeJev(base.jev, patch.jev) ? { jev: mergeJev(base.jev, patch.jev) } : {}),
    ...(mergeRag(base.rag, patch.rag) ? { rag: mergeRag(base.rag, patch.rag) } : {}),
    ...(patch.maxEntries !== undefined ? { maxEntries: patch.maxEntries } : {}),
    ...(patch.maxBytes !== undefined ? { maxBytes: patch.maxBytes } : {}),
  }
}

function resolvePolicy(value: MemoryPolicy): ResolvedMemoryPolicy {
  const mode = value.mode ?? DEFAULT_MEMORY_POLICY.mode
  const scope = value.scope ?? DEFAULT_MEMORY_POLICY.scope
  return {
    mode,
    scope,
    ...(value.scopeValue !== undefined ? { scopeValue: value.scopeValue } : {}),
    write: {
      approval: value.write?.approval ?? DEFAULT_MEMORY_POLICY.write.approval,
    },
    jev: {
      enabled: value.jev?.enabled ?? DEFAULT_MEMORY_POLICY.jev.enabled,
      backend: value.jev?.backend ?? DEFAULT_MEMORY_POLICY.jev.backend,
      scope: value.jev?.scope ?? scope,
      ...(value.jev?.scopeValue ?? value.scopeValue
        ? { scopeValue: value.jev?.scopeValue ?? value.scopeValue }
        : {}),
      reanalyzeOnCompaction: value.jev?.reanalyzeOnCompaction
        ?? DEFAULT_MEMORY_POLICY.jev.reanalyzeOnCompaction,
    },
    rag: { topK: value.rag?.topK ?? DEFAULT_MEMORY_POLICY.rag.topK },
    maxEntries: value.maxEntries ?? DEFAULT_MEMORY_POLICY.maxEntries,
    maxBytes: value.maxBytes ?? DEFAULT_MEMORY_POLICY.maxBytes,
  }
}

export interface MemoryPolicyStoreOptions {
  readonly agentIdFor?: (sessionId: string) => string | undefined
}

export class MemoryPolicyStore {
  readonly root: string
  private readonly file: string
  private readonly agentIdFor?: (sessionId: string) => string | undefined
  private doc: MemoryPolicyDocument

  constructor(root: string, options: MemoryPolicyStoreOptions = {}) {
    this.root = root
    this.file = join(root, 'policy.json')
    this.agentIdFor = options.agentIdFor
    this.doc = this.load()
  }

  resolve(sessionId: string, agentId?: string): ResolvedMemoryPolicy {
    const effectiveAgent = agentId ?? (sessionId ? this.agentIdFor?.(sessionId) : undefined)
    let merged = mergePolicy({}, this.doc.default)
    if (effectiveAgent && this.doc.agents[effectiveAgent]) {
      merged = mergePolicy(merged, this.doc.agents[effectiveAgent])
    }
    if (this.doc.sessions[sessionId]) {
      merged = mergePolicy(merged, this.doc.sessions[sessionId])
    }
    return resolvePolicy(merged)
  }

  getDocument(): Readonly<MemoryPolicyDocument> {
    return this.doc
  }

  setDefault(patch: MemoryPolicy): void {
    this.doc = { ...this.doc, default: mergePolicy(this.doc.default, patch) }
    this.save()
  }

  setAgent(agentId: string, patch: MemoryPolicy): void {
    this.doc = {
      ...this.doc,
      agents: { ...this.doc.agents, [agentId]: mergePolicy(this.doc.agents[agentId] ?? {}, patch) },
    }
    this.save()
  }

  setSession(sessionId: string, patch: MemoryPolicy): void {
    this.doc = {
      ...this.doc,
      sessions: {
        ...this.doc.sessions,
        [sessionId]: mergePolicy(this.doc.sessions[sessionId] ?? {}, patch),
      },
    }
    this.save()
  }

  /** 从磁盘重载；policy.json 被库编辑器改过后调用。 */
  reload(): void {
    this.doc = this.load()
  }

  /** 写前校验：至少保证 version 和三级对象形状正确。 */
  validateText(text: string): void {
    const raw = JSON.parse(text) as Partial<MemoryPolicyDocument>
    if (raw.version !== 1) throw new Error('unsupported policy version')
    for (const key of ['default', 'agents', 'sessions'] as const) {
      if (raw[key] !== undefined && (typeof raw[key] !== 'object' || raw[key] === null || Array.isArray(raw[key]))) {
        throw new Error(`policy.${key} must be an object`)
      }
    }
  }

  private load(): MemoryPolicyDocument {
    if (!existsSync(this.file)) {
      return { version: 1, default: {}, agents: {}, sessions: {} }
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MemoryPolicyDocument>
      if (raw.version !== 1) throw new Error('unsupported policy version')
      return {
        version: 1,
        default: raw.default ?? {},
        agents: raw.agents ?? {},
        sessions: raw.sessions ?? {},
      }
    } catch {
      // 策略坏了就用默认值，不阻塞记忆。
      return { version: 1, default: {}, agents: {}, sessions: {} }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.doc, null, 2)}\n`, 'utf8')
    renameSync(temp, this.file)
  }
}
