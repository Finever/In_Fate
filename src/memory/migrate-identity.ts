/**
 * 把旧的 SOUL/USER/FACT 迁到 agent manifest + identity 槽位。
 *
 * 默认 dry-run；只新增新文件，不删除旧文件。目标文件已存在且内容不同时，
 * 默认拒绝，必须显式 force（先备份再覆盖）。
 *
 * @module if/memory/migrate-identity
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../core/lock.ts'
import {
  AgentManifestStore,
  defaultIdentitySlots,
  type AgentManifest,
  type IdentitySlot,
  type IdentitySlotName,
} from './agent-manifest.ts'

export interface LegacyIdentitySource {
  readonly slot: string
  readonly legacyPath: string
  readonly file: string
  readonly label: string
  readonly role: string
  readonly order: number
}

export const LEGACY_IDENTITY_SOURCES: readonly LegacyIdentitySource[] = [
  {
    slot: 'principle',
    legacyPath: 'SOUL.md',
    file: 'principle.md',
    label: 'Principle',
    role: 'identity',
    order: 100,
  },
  {
    slot: 'preference',
    legacyPath: 'USER.md',
    file: 'preference.md',
    label: 'Preference',
    role: 'user',
    order: 90,
  },
  {
    slot: 'prompt',
    legacyPath: join('memory', 'FACT.md'),
    file: 'prompt.md',
    label: 'Prompt',
    role: 'fact',
    order: 80,
  },
]

export interface IdentityMigrationFile {
  readonly slot: string
  readonly source: string
  readonly target: string
  readonly bytes: number
  readonly targetExists: boolean
  readonly identical: boolean
  readonly conflict: boolean
}

export interface IdentityMigrationPlan {
  readonly agentId: string
  readonly memoryRoot: string
  readonly manifest: AgentManifest
  readonly manifestPath: string
  readonly files: readonly IdentityMigrationFile[]
  readonly missingLegacy: readonly string[]
}

export interface IdentityMigrationOptions {
  readonly agentDir: string
  readonly memoryRoot: string
  readonly agentId: string
  readonly name?: string
  readonly labels?: Partial<Record<IdentitySlotName, string>>
  /** 目标文件已存在且内容不同时，允许备份后覆盖 */
  readonly force?: boolean
}

function slotsForMigration(
  labels: IdentityMigrationOptions['labels'] = {},
): IdentitySlot[] {
  const slots = defaultIdentitySlots(labels)
  return slots.map(slot => {
    const legacy = LEGACY_IDENTITY_SOURCES.find(item => item.slot === slot.id)
    if (!legacy) return slot
    return {
      ...slot,
      file: legacy.file,
      role: legacy.role,
      order: legacy.order,
    }
  })
}

export function planIdentityMigration(options: IdentityMigrationOptions): IdentityMigrationPlan {
  const store = new AgentManifestStore(options.memoryRoot)
  if (store.read(options.agentId)) {
    throw new Error(`agent manifest already exists: ${store.path(options.agentId)}`)
  }

  const manifest: AgentManifest = {
    version: 1,
    id: options.agentId,
    name: options.name ?? options.agentId,
    identity: slotsForMigration(options.labels),
  }
  const files: IdentityMigrationFile[] = []
  const missingLegacy: string[] = []

  for (const slot of manifest.identity) {
    const legacy = LEGACY_IDENTITY_SOURCES.find(item => item.slot === slot.id)
    if (!legacy) continue
    const source = join(options.agentDir, legacy.legacyPath)
    if (!existsSync(source)) {
      missingLegacy.push(source)
      continue
    }
    const target = store.slotPath(manifest.id, slot)
    const content = readFileSync(source)
    const targetExists = existsSync(target)
    const identical = targetExists && readFileSync(target).equals(content)
    files.push({
      slot: slot.id,
      source,
      target,
      bytes: statSync(source).size,
      targetExists,
      identical,
      conflict: targetExists && !identical,
    })
  }

  if (files.length === 0) {
    throw new Error(`no legacy identity files found under ${options.agentDir}`)
  }

  // 只保留有来源的槽位；缺失的文件留给后续 UI 补建。
  const withFiles = new Set(files.map(file => file.slot))
  return {
    agentId: manifest.id,
    memoryRoot: options.memoryRoot,
    manifest: {
      ...manifest,
      identity: manifest.identity.filter(slot => withFiles.has(slot.id)),
    },
    manifestPath: store.path(manifest.id),
    files,
    missingLegacy,
  }
}

export interface IdentityMigrationResult {
  readonly manifestPath: string
  readonly written: readonly string[]
  readonly skipped: readonly string[]
  readonly backups: readonly string[]
}

export async function applyIdentityMigration(
  plan: IdentityMigrationPlan,
  options: { force?: boolean } = {},
): Promise<IdentityMigrationResult> {
  const store = new AgentManifestStore(plan.memoryRoot)
  const conflicts = plan.files.filter(file => file.conflict)
  if (conflicts.length > 0 && options.force !== true) {
    throw new Error(`identity target conflict: ${conflicts.map(file => file.target).join(', ')}`)
  }

  const written: string[] = []
  const skipped: string[] = []
  const backups: string[] = []
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const archiveDir = join(store.dir(plan.agentId), '_archive')

  for (const file of plan.files) {
    if (file.identical) {
      skipped.push(file.target)
      continue
    }
    mkdirSync(store.identityDir(plan.agentId), { recursive: true })
    if (existsSync(file.target)) {
      mkdirSync(archiveDir, { recursive: true })
      const backup = join(archiveDir, `${file.slot}-migration-${stamp}.md`)
      copyFileSync(file.target, backup)
      backups.push(backup)
    }
    const content = readFileSync(file.source)
    await withFileLock(file.target, () => {
      const temp = `${file.target}.${process.pid}.tmp`
      writeFileSync(temp, content)
      renameSync(temp, file.target)
    }, { timeoutMs: 5_000 })
    written.push(file.target)
  }

  await store.write(plan.manifest)

  return {
    manifestPath: plan.manifestPath,
    written,
    skipped,
    backups,
  }
}
