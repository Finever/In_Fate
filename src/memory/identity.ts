import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendIdentitySection, assertIdentitySection, replaceIdentitySection } from './identity-sections.ts'

export type IdentityFile = 'SOUL' | 'USER' | 'FACT'
export type IdentityPatchMode = 'replace-section' | 'append'

export interface IdentityPatch {
  readonly file: IdentityFile
  readonly section: string
  readonly content: string
  readonly mode?: IdentityPatchMode
}

export interface IdentityApplyResult {
  readonly file: IdentityFile
  readonly path: string
  readonly backup: string
}

export interface IdentityPreview {
  readonly file: IdentityFile
  readonly path: string
  readonly before: string
  readonly after: string
}

/** 旧文件存储和新 manifest 槽位存储共用的接口。 */
export interface IdentityStoreLike {
  read(file: IdentityFile): string
  path(file: IdentityFile): string
  preview(patch: IdentityPatch): IdentityPreview
  apply(patch: IdentityPatch): IdentityApplyResult | Promise<IdentityApplyResult>
}

const FILES: Record<IdentityFile, (agentDir: string) => string> = {
  SOUL: agentDir => join(agentDir, 'SOUL.md'),
  USER: agentDir => join(agentDir, 'USER.md'),
  FACT: agentDir => join(agentDir, 'memory', 'FACT.md'),
}

function stamp(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${iso}-${Math.random().toString(36).slice(2, 6)}`
}

function assertSection(section: string): void {
  if (section.trim().length === 0 || section.includes('\n') || section.length > 80) {
    throw new Error(`invalid identity section: ${JSON.stringify(section)}`)
  }
}

export class MemoryIdentityStore implements IdentityStoreLike {
  readonly agentDir: string
  readonly archiveDir: string
  private readonly now: () => Date

  constructor(agentDir: string, options: { archiveDir?: string; now?: () => Date } = {}) {
    this.agentDir = agentDir
    this.archiveDir = options.archiveDir ?? join(agentDir, 'memory', '_archive')
    this.now = options.now ?? (() => new Date())
  }

  read(file: IdentityFile): string {
    const path = this.pathFor(file)
    if (!existsSync(path)) throw new Error(`identity file not found: ${path}`)
    return readFileSync(path, 'utf8')
  }

  path(file: IdentityFile): string {
    return this.pathFor(file)
  }

  /** 只计算写入后的文本，不碰文件；proposal 用它记录 before/after 指纹。 */
  preview(patch: IdentityPatch): IdentityPreview {
    const rendered = this.render(patch)
    return {
      file: patch.file,
      path: rendered.path,
      before: rendered.original,
      after: rendered.next,
    }
  }

  apply(patch: IdentityPatch): IdentityApplyResult {
    const rendered = this.render(patch)
    mkdirSync(this.archiveDir, { recursive: true })
    const backup = join(this.archiveDir, `${patch.file}-identity-${stamp(this.now())}.md`)
    copyFileSync(rendered.path, backup)

    const temp = `${rendered.path}.${process.pid}.tmp`
    writeFileSync(temp, rendered.next, 'utf8')
    renameSync(temp, rendered.path)
    return { file: patch.file, path: rendered.path, backup }
  }

  private render(patch: IdentityPatch): { path: string; original: string; next: string } {
    assertIdentitySection(patch.section)
    if (patch.content.trim().length === 0) throw new Error('identity patch content is empty')
    const path = this.pathFor(patch.file)
    if (!existsSync(path)) throw new Error(`identity file not found: ${path}`)
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

  private pathFor(file: IdentityFile): string {
    const resolvePath = FILES[file]
    if (!resolvePath) throw new Error(`unknown identity file: ${file}`)
    return resolvePath(this.agentDir)
  }
}
