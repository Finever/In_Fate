import type { ToolSpec } from '../model/types.ts'
import {
  toModelSpec,
  type ApprovalMode,
  type ToolChange,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolPatch,
  type ToolPolicyEntry,
  type ToolSource,
} from './types.ts'

export interface ToolRegisterOptions {
  readonly enabled?: boolean
  readonly approval?: ApprovalMode
}

interface Entry {
  readonly tool: ToolDefinition
  readonly source: ToolSource
  enabled: boolean
  approval: ApprovalMode
  revision: number
  overrides: ToolPatch
}

export class ToolRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(change: ToolChange) => void>()

  register(
    tool: ToolDefinition,
    source: ToolSource = 'builtin',
    options: ToolRegisterOptions = {},
  ): ToolDescriptor {
    if (this.entries.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    const entry: Entry = {
      tool,
      source,
      enabled: options.enabled ?? true,
      approval: options.approval ?? (tool.meta?.dangerous ? 'required' : 'auto'),
      revision: 1,
      overrides: {},
    }
    this.entries.set(tool.name, entry)
    const descriptor = this.describe(tool.name, entry)
    this.emit({ type: 'added', name: tool.name, descriptor })
    return descriptor
  }

  unregister(name: string): boolean {
    const entry = this.entries.get(name)
    if (!entry) return false
    const descriptor = this.describe(name, entry)
    this.entries.delete(name)
    this.emit({ type: 'removed', name, descriptor })
    return true
  }

  update(name: string, patch: ToolPatch): ToolDescriptor {
    const entry = this.mustGet(name)
    const wasEnabled = entry.enabled
    entry.overrides = { ...entry.overrides, ...patch }
    if (patch.enabled !== undefined) entry.enabled = patch.enabled
    if (patch.approval !== undefined) entry.approval = patch.approval
    entry.revision += 1

    const descriptor = this.describe(name, entry)
    const type = wasEnabled !== entry.enabled
      ? (entry.enabled ? 'enabled' : 'disabled')
      : 'updated'
    this.emit({ type, name, descriptor })
    return descriptor
  }

  setEnabled(name: string, enabled: boolean): ToolDescriptor {
    return this.update(name, { enabled })
  }

  list(options: { includeDisabled?: boolean } = {}): ToolDescriptor[] {
    const out: ToolDescriptor[] = []
    for (const [name, entry] of this.entries) {
      if (!options.includeDisabled && !entry.enabled) continue
      out.push(this.describe(name, entry))
    }
    return out
  }

  get(name: string): ToolDefinition | undefined {
    return this.entries.get(name)?.tool
  }

  /** 执行时用的有效超时：工具声明优先，其次调用方给的默认值。 */
  timeoutOf(name: string, fallback = 120_000): number {
    const entry = this.entries.get(name)
    return entry?.overrides.timeoutMs ?? entry?.tool.meta?.timeoutMs ?? fallback
  }

  policy(name: string): ToolPolicyEntry | undefined {
    const entry = this.entries.get(name)
    if (!entry) return undefined
    return {
      name,
      source: entry.source,
      approval: entry.approval,
      bypass: entry.enabled ? 'lift' : 'enforce',
    }
  }

  /**
   * 模型可见的工具。
   *
   * 没有显式 allow 时，plugin 来源默认不可见；插件工具必须由 agent
   * 明确列入白名单，避免“装一个插件，所有 agent 都能用”。
   */
  toModelSpecs(options: { readonly allowed?: ReadonlySet<string> } = {}): ToolSpec[] {
    return this.list()
      .filter(entry => options.allowed
        ? options.allowed.has(entry.name)
        : entry.source !== 'plugin')
      .map(toModelSpec)
  }

  /** 订阅工具变更。返回取消函数。 */
  onChange(listener: (change: ToolChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private mustGet(name: string): Entry {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`unknown tool: ${name}`)
    return entry
  }

  private describe(name: string, entry: Entry): ToolDescriptor {
    return {
      name,
      description: entry.overrides.description ?? entry.tool.description,
      inputSchema: entry.overrides.inputSchema ?? entry.tool.inputSchema,
      source: entry.source,
      enabled: entry.enabled,
      approval: entry.approval,
      revision: entry.revision,
      dangerous: Boolean(entry.tool.meta?.dangerous),
      readOnly: Boolean(entry.tool.meta?.readOnly),
    }
  }

  private emit(change: ToolChange): void {
    for (const listener of this.listeners) listener(change)
  }
}
