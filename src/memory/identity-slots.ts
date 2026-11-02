/**
 * Manifest 驱动的身份槽位读写。
 *
 * 槽位 id 稳定；文件路径来自 manifest。写入只动指定二级标题，先备份再替换。
 *
 * @module if/memory/identity-slots
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from '../core/lock.ts'
import {
  AgentManifestStore,
  type AgentManifest,
  type IdentitySlot,
} from './agent-manifest.ts'
import {
  appendIdentitySection,
  assertIdentitySection,
  replaceIdentitySection,
} from './identity-sections.ts'

export type IdentityPatchMode = 'replace-section' | 'append'

export interface SlotIdentityPatch {
  readonly slot: string
  readonly section: string
  readonly content: string
  readonly mode?: IdentityPatchMode
}

export interface SlotIdentityPreview {
  readonly slot: string
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface SlotIdentityApplyResult {
  readonly slot: string
  readonly path: string
  readonly backup: string
}

function stamp(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${iso}-${Math.random().toString(36).slice(2, 6)}`
}

export class AgentIdentityStore {
  readonly memoryRoot: string
  readonly agentId: string
  readonly manifestStore: AgentManifestStore
  readonly archiveDir: string
  private readonly now: () => Date
  private manifestValue?: AgentManifest

  constructor(
    memoryRoot: string,
    agentId: string,
    options: {
      manifest?: AgentManifest
      archiveDir?: string
      now?: () => Date
    } = {},
  ) {
    this.memoryRoot = memoryRoot
    this.agentId = agentId
    this.manifestStore = new AgentManifestStore(memoryRoot)
    this.archiveDir = options.archiveDir ?? join(this.manifestStore.dir(agentId), '_archive')
    this.now = options.now ?? (() => new Date())
    if (options.manifest) this.manifestValue = options.manifest
  }

  manifest(): AgentManifest {
    if (!this.manifestValue) this.manifestValue = this.manifestStore.readOrThrow(this.agentId)
    return this.manifestValue
  }

  slots(): readonly IdentitySlot[] {
    return [...this.manifest().identity].sort((a, b) => b.order - a.order)
  }

  slot(slotId: string): IdentitySlot {
    const slot = this.manifest().identity.find(item => item.id === slotId)
    if (!slot) throw new Error(`unknown identity slot: ${slotId}`)
    return slot
  }

  path(slotId: string): string {
    return this.manifestStore.slotPath(this.agentId, this.slot(slotId))
  }

  read(slotId: string): string {
    const path = this.path(slotId)
    if (!existsSync(path)) throw new Error(`identity slot file not found: ${path}`)
    return readFileSync(path, 'utf8')
  }

  readOrEmpty(slotId: string): string {
    const path = this.path(slotId)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  /** 人类 UI 的整文件保存；先备份，再原子替换。 */
  async writeSlot(slotId: string, content: string): Promise<{ path: string; backup: string }> {
    const path = this.path(slotId)
    return withFileLock(path, () => {
      mkdirSync(this.archiveDir, { recursive: true })
      const backup = existsSync(path)
        ? join(this.archiveDir, `${slotId}-identity-${stamp(this.now())}.md`)
        : ''
      if (backup) copyFileSync(path, backup)
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, content, 'utf8')
      renameSync(temp, path)
      return { path, backup }
    }, { timeoutMs: 5_000 })
  }

  preview(patch: SlotIdentityPatch): SlotIdentityPreview {
    const rendered = this.render(patch)
    return {
      slot: patch.slot,
      path: rendered.path,
      before: rendered.original,
      after: rendered.next,
    }
  }

  async apply(patch: SlotIdentityPatch): Promise<SlotIdentityApplyResult> {
    const path = this.path(patch.slot)
    return withFileLock(path, () => {
      const rendered = this.render(patch)
      mkdirSync(this.archiveDir, { recursive: true })
      const backup = join(this.archiveDir, `${patch.slot}-identity-${stamp(this.now())}.md`)
      copyFileSync(rendered.path, backup)

      const temp = `${rendered.path}.${process.pid}.tmp`
      writeFileSync(temp, rendered.next, 'utf8')
      renameSync(temp, rendered.path)
      return { slot: patch.slot, path: rendered.path, backup }
    }, { timeoutMs: 5_000 })
  }

  private render(patch: SlotIdentityPatch): { path: string; original: string; next: string } {
    assertIdentitySection(patch.section)
    if (patch.content.trim().length === 0) throw new Error('identity patch content is empty')
    const path = this.path(patch.slot)
    if (!existsSync(path)) throw new Error(`identity slot file not found: ${path}`)
    const original = readFileSync(path, 'utf8')
    const mode = patch.mode ?? 'replace-section'
    return {
      path,
      original,
      next: mode === 'append'
        ? appendIdentitySection(original, patch.section, patch.content)
        : replaceIdentitySection(original, patch.section, patch.content),
    }
  }
}
