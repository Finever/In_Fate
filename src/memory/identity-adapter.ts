import type {
  IdentityApplyResult,
  IdentityFile,
  IdentityPatch,
  IdentityPreview,
  IdentityStoreLike,
} from './identity.ts'
import type { AgentIdentityStore } from './identity-slots.ts'

const FILE_TO_SLOT: Record<IdentityFile, string> = {
  SOUL: 'principle',
  USER: 'preference',
  FACT: 'prompt',
}

const FILE_TO_ROLE: Record<IdentityFile, string> = {
  SOUL: 'identity',
  USER: 'user',
  FACT: 'fact',
}

export class ManifestIdentityStore implements IdentityStoreLike {
  readonly agentIdentity: AgentIdentityStore

  constructor(agentIdentity: AgentIdentityStore) {
    this.agentIdentity = agentIdentity
  }

  read(file: IdentityFile): string {
    return this.agentIdentity.read(this.slotId(file))
  }

  path(file: IdentityFile): string {
    return this.agentIdentity.path(this.slotId(file))
  }

  preview(patch: IdentityPatch): IdentityPreview {
    const preview = this.agentIdentity.preview({
      slot: this.slotId(patch.file),
      section: patch.section,
      content: patch.content,
      ...(patch.mode ? { mode: patch.mode } : {}),
    })
    return {
      file: patch.file,
      path: preview.path,
      before: preview.before,
      after: preview.after,
    }
  }

  async apply(patch: IdentityPatch): Promise<IdentityApplyResult> {
    const result = await this.agentIdentity.apply({
      slot: this.slotId(patch.file),
      section: patch.section,
      content: patch.content,
      ...(patch.mode ? { mode: patch.mode } : {}),
    })
    return { file: patch.file, path: result.path, backup: result.backup }
  }

  private slotId(file: IdentityFile): string {
    const slots = this.agentIdentity.manifest().identity
    const preferred = FILE_TO_SLOT[file]
    if (slots.some(slot => slot.id === preferred)) return preferred
    const role = FILE_TO_ROLE[file]
    const fallback = slots.find(slot => slot.role === role)
    if (!fallback) throw new Error(`identity slot for ${file} not found`)
    return fallback.id
  }
}
