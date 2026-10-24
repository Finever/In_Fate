/**
 * Agent manifest：`<memoryRoot>/agents/<agentId>/agent.json`。
 *
 * 身份槽位 id 稳定；label 是给 UI/模型看的名字，file 是 identity 目录里的
 * 文件名。旧 SOUL/USER/FACT 只是 legacy 默认值，不是系统假设。
 *
 * @module if/memory/agent-manifest
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
import { assertWithin } from '../core/safe-path.ts'

export type IdentitySourceLayer = 'stable' | 'dynamic' | 'ephemeral'

export interface IdentitySlot {
  /** 稳定 id，例如 self / user / context；UI 不直接改 */
  readonly id: string
  /** 显示名，例如 本心 / 所爱 / 当口 */
  readonly label: string
  /** identity 目录里的文件名 */
  readonly file: string
  /** 越大越先进入上下文 */
  readonly order: number
  /** 记忆源角色，默认 identity */
  readonly role?: string
  readonly layer?: IdentitySourceLayer
  readonly priority?: number
}

export interface AgentManifest {
  readonly version: 1
  readonly id: string
  readonly name: string
  readonly identity: readonly IdentitySlot[]
}

const BAD_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/
const SLOT_ID = /^[a-z][a-z0-9_-]*$/

function assertSegment(value: string, label: string): string {
  if (typeof value !== 'string' || (
    value.length === 0
    || value === '.'
    || value === '..'
    || BAD_SEGMENT.test(value)
    || /[. ]$/.test(value)
  )) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

function assertFile(value: string): string {
  assertSegment(value, 'identity file')
  if (!value.endsWith('.md')) throw new Error(`identity file must end with .md: ${value}`)
  return value
}

export function validateAgentManifest(manifest: AgentManifest): AgentManifest {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('agent manifest must be an object')
  if (manifest.version !== 1) throw new Error(`unsupported agent manifest version: ${String(manifest.version)}`)
  assertSegment(manifest.id, 'agent id')
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new Error('agent manifest needs a name')
  }
  if (!Array.isArray(manifest.identity) || manifest.identity.length === 0) {
    throw new Error('agent manifest needs at least one identity slot')
  }

  const ids = new Set<string>()
  const files = new Set<string>()
  for (const slot of manifest.identity) {
    if (!SLOT_ID.test(slot.id)) {
      throw new Error(`invalid identity slot id: ${JSON.stringify(slot.id)}`)
    }
    if (ids.has(slot.id)) throw new Error(`duplicate identity slot id: ${slot.id}`)
    ids.add(slot.id)

    if (typeof slot.label !== 'string' || slot.label.trim().length === 0 || slot.label.includes('\n')) {
      throw new Error(`invalid identity slot label: ${JSON.stringify(slot.label)}`)
    }
    if (slot.label.length > 80) throw new Error(`identity slot label too long: ${slot.label}`)
    assertFile(slot.file)
    if (files.has(slot.file)) throw new Error(`duplicate identity file: ${slot.file}`)
    files.add(slot.file)
    if (!Number.isFinite(slot.order)) throw new Error(`invalid identity slot order: ${String(slot.order)}`)
  }

  return manifest
}

export function defaultIdentitySlots(
  labels: Partial<Record<'self' | 'user' | 'context', string>> = {},
): IdentitySlot[] {
  return [
    { id: 'self', label: labels.self ?? 'SOUL', file: 'self.md', order: 100, role: 'identity', layer: 'stable' },
    { id: 'user', label: labels.user ?? 'USER', file: 'user.md', order: 90, role: 'user', layer: 'stable' },
    { id: 'context', label: labels.context ?? 'FACT', file: 'context.md', order: 80, role: 'fact', layer: 'stable' },
  ]
}

export function defaultAgentManifest(
  agentId: string,
  name = agentId,
  labels: Partial<Record<'self' | 'user' | 'context', string>> = {},
): AgentManifest {
  return validateAgentManifest({
    version: 1,
    id: agentId,
    name,
    identity: defaultIdentitySlots(labels),
  })
}

export class AgentManifestStore {
  readonly memoryRoot: string
  readonly agentsRoot: string

  constructor(memoryRoot: string) {
    this.memoryRoot = memoryRoot
    this.agentsRoot = join(memoryRoot, 'agents')
  }

  dir(agentId: string): string {
    assertSegment(agentId, 'agent id')
    return join(this.agentsRoot, agentId)
  }

  identityDir(agentId: string): string {
    return join(this.dir(agentId), 'identity')
  }

  path(agentId: string): string {
    return join(this.dir(agentId), 'agent.json')
  }

  slotPath(agentId: string, slot: IdentitySlot): string {
    const dir = this.identityDir(agentId)
    return assertWithin(dir, join(dir, assertFile(slot.file)), 'identity file')
  }

  read(agentId: string): AgentManifest | undefined {
    const path = this.path(agentId)
    if (!existsSync(path)) return undefined
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AgentManifest
    const manifest = validateAgentManifest(raw)
    if (manifest.id !== agentId) {
      throw new Error(`agent manifest id mismatch: ${manifest.id} vs ${agentId}`)
    }
    return manifest
  }

  readOrThrow(agentId: string): AgentManifest {
    const manifest = this.read(agentId)
    if (!manifest) throw new Error(`agent manifest not found: ${this.path(agentId)}`)
    return manifest
  }

  list(): AgentManifest[] {
    if (!existsSync(this.agentsRoot)) return []
    const out: AgentManifest[] = []
    for (const entry of readdirSync(this.agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const manifest = this.read(entry.name)
        if (manifest) out.push(manifest)
      } catch {
        // 坏 manifest 不阻断其他 agent 的列表
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  async write(manifest: AgentManifest): Promise<void> {
    const validated = validateAgentManifest(manifest)
    const path = this.path(validated.id)
    mkdirSync(this.dir(validated.id), { recursive: true })
    await withFileLock(path, () => {
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    }, { timeoutMs: 5_000 })
  }

  async ensureDefault(
    agentId: string,
    name = agentId,
    labels: Partial<Record<'self' | 'user' | 'context', string>> = {},
  ): Promise<AgentManifest> {
    const existing = this.read(agentId)
    if (existing) return existing
    const manifest = defaultAgentManifest(agentId, name, labels)
    await this.write(manifest)
    return manifest
  }
}
