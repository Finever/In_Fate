/**
 * 主 agent 的运行设置：模型、子 agent 可用模型、预设与工具策略。
 *
 * 存在数据目录，不进记忆库 git；PPP 与 agent.json 仍是身份层。
 *
 * @module if/agents/settings
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../core/lock.ts'
import type { ApprovalMode } from '../tools/types.ts'

export interface ModelRef {
  readonly provider: string
  readonly model: string
}

export interface AgentModelSettings {
  /** 主 agent 当前模型；没有就不允许跑。 */
  readonly main?: ModelRef
  /** 子 agent 可用模型；保存时自动并入 main。 */
  readonly subagents?: readonly ModelRef[]
}

export interface AgentToolSettings {
  /** undefined = 全部全局启用工具；[] = 全禁。 */
  readonly allow?: readonly string[]
  /** 按工具覆盖审批模式。 */
  readonly approval?: Readonly<Record<string, ApprovalMode>>
}

/** 主 agent 派活时可见的子 agent 策略。 */
export interface SubagentPolicy {
  readonly presets?: readonly string[]
  readonly models: readonly ModelRef[]
  readonly mainModel?: ModelRef
  readonly toolAllow?: readonly string[]
}

export interface AgentSettings {
  readonly version: 1
  readonly agentId: string
  readonly models?: AgentModelSettings
  /** undefined = 全部预设；[] = 全禁。 */
  readonly subagentPresets?: readonly string[]
  readonly tools?: AgentToolSettings
  readonly updatedAt?: string
}

const BAD_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/

function assertAgentId(agentId: string): string {
  if (
    typeof agentId !== 'string'
    || agentId.length === 0
    || agentId === '.'
    || agentId === '..'
    || BAD_SEGMENT.test(agentId)
    || /[. ]$/.test(agentId)
  ) {
    throw new Error(`unsafe agent id: ${JSON.stringify(agentId)}`)
  }
  return agentId
}

function assertModelRef(value: ModelRef | undefined, path: string): void {
  if (!value) return
  if (typeof value.provider !== 'string' || value.provider.trim().length === 0) {
    throw new Error(`${path}.provider must be a non-empty string`)
  }
  if (typeof value.model !== 'string' || value.model.trim().length === 0) {
    throw new Error(`${path}.model must be a non-empty string`)
  }
}

function normalizeModels(models: AgentModelSettings | undefined): AgentModelSettings | undefined {
  if (!models) return undefined
  const subagents: ModelRef[] = []
  const seen = new Set<string>()
  for (const choice of models.subagents ?? []) {
    assertModelRef(choice, 'models.subagents')
    const key = `${choice.provider}\u0000${choice.model}`
    if (seen.has(key)) continue
    seen.add(key)
    subagents.push({ provider: choice.provider, model: choice.model })
  }
  if (models.main) {
    assertModelRef(models.main, 'models.main')
    const key = `${models.main.provider}\u0000${models.main.model}`
    if (!seen.has(key)) subagents.unshift({ provider: models.main.provider, model: models.main.model })
  }
  return {
    ...(models.main ? { main: { provider: models.main.provider, model: models.main.model } } : {}),
    subagents,
  }
}

export function validateAgentSettings(settings: AgentSettings): AgentSettings {
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('agent settings must be an object')
  }
  if (settings.version !== 1) {
    throw new Error(`unsupported agent settings version: ${String(settings.version)}`)
  }
  assertAgentId(settings.agentId)
  if (settings.subagentPresets !== undefined) {
    if (!Array.isArray(settings.subagentPresets)) {
      throw new Error('subagentPresets must be an array')
    }
    const seen = new Set<string>()
    for (const preset of settings.subagentPresets) {
      if (typeof preset !== 'string' || preset.trim().length === 0) {
        throw new Error('subagentPresets must contain non-empty strings')
      }
      if (seen.has(preset)) throw new Error(`duplicate subagent preset: ${preset}`)
      seen.add(preset)
    }
  }
  if (settings.tools !== undefined) {
    if (!Array.isArray(settings.tools.allow ?? [])) {
      throw new Error('tools.allow must be an array')
    }
    const seen = new Set<string>()
    for (const tool of settings.tools.allow ?? []) {
      if (typeof tool !== 'string' || tool.trim().length === 0) {
        throw new Error('tools.allow must contain non-empty strings')
      }
      if (seen.has(tool)) throw new Error(`duplicate tool allow entry: ${tool}`)
      seen.add(tool)
    }
    for (const [name, mode] of Object.entries(settings.tools.approval ?? {})) {
      if (name.trim().length === 0) throw new Error('tool approval needs a tool name')
      if (mode !== 'auto' && mode !== 'required') {
        throw new Error(`invalid approval mode for ${name}: ${String(mode)}`)
      }
    }
  }
  return {
    version: 1,
    agentId: settings.agentId,
    ...(settings.models ? { models: normalizeModels(settings.models)! } : {}),
    ...(settings.subagentPresets !== undefined
      ? { subagentPresets: [...settings.subagentPresets] }
      : {}),
    ...(settings.tools
      ? {
        tools: {
          ...(settings.tools.allow !== undefined ? { allow: [...settings.tools.allow] } : {}),
          ...(settings.tools.approval ? { approval: { ...settings.tools.approval } } : {}),
        },
      }
      : {}),
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {}),
  }
}

export interface AgentSettingsStoreOptions {
  readonly now?: () => Date
}

export class AgentSettingsStore {
  readonly dataRoot: string
  readonly agentsRoot: string
  private readonly now: () => Date

  constructor(dataRoot: string, options: AgentSettingsStoreOptions = {}) {
    this.dataRoot = dataRoot
    this.agentsRoot = join(dataRoot, 'agents')
    this.now = options.now ?? ((): Date => new Date())
  }

  dir(agentId: string): string {
    return join(this.agentsRoot, assertAgentId(agentId))
  }

  path(agentId: string): string {
    return join(this.dir(agentId), 'settings.json')
  }

  read(agentId: string): AgentSettings | undefined {
    const path = this.path(agentId)
    if (!existsSync(path)) return undefined
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AgentSettings
    const settings = validateAgentSettings(raw)
    if (settings.agentId !== agentId) {
      throw new Error(`agent settings id mismatch: ${settings.agentId} vs ${agentId}`)
    }
    return settings
  }

  list(): AgentSettings[] {
    if (!existsSync(this.agentsRoot)) return []
    const out: AgentSettings[] = []
    for (const entry of readdirSync(this.agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const settings = this.read(entry.name)
        if (settings) out.push(settings)
      } catch {
        // 坏设置不阻断其他 agent
      }
    }
    return out.sort((a, b) => a.agentId.localeCompare(b.agentId))
  }

  async write(settings: AgentSettings): Promise<AgentSettings> {
    const next = validateAgentSettings({
      ...settings,
      version: 1,
      updatedAt: this.now().toISOString(),
    })
    const path = this.path(next.agentId)
    mkdirSync(this.dir(next.agentId), { recursive: true })
    await withFileLock(path, () => {
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    }, { timeoutMs: 5_000 })
    return next
  }

  async update(
    agentId: string,
    mutate: (current: AgentSettings) => AgentSettings,
  ): Promise<AgentSettings> {
    const path = this.path(agentId)
    mkdirSync(this.dir(agentId), { recursive: true })
    let result: AgentSettings | undefined
    await withFileLock(path, () => {
      const current = this.read(agentId) ?? {
        version: 1,
        agentId,
        models: { subagents: [] },
      }
      result = validateAgentSettings({
        ...mutate(current),
        version: 1,
        agentId,
        updatedAt: this.now().toISOString(),
      })
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    }, { timeoutMs: 5_000 })
    return result!
  }
}

export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a?.provider === b?.provider && a?.model === b?.model
}
