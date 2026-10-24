/**
 * 身份记忆（SOUL / USER / FACT）的受控写入。
 *
 * 只接受“替换某个二级标题的内容”或“追加一个新二级标题”；
 * 不接受整文件覆盖。每次写入前先备份到 memory/_archive。
 *
 * @module if/memory/identity
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export class MemoryIdentityStore {
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

  apply(patch: IdentityPatch): IdentityApplyResult {
    assertSection(patch.section)
    if (patch.content.trim().length === 0) throw new Error('identity patch content is empty')
    const path = this.pathFor(patch.file)
    if (!existsSync(path)) throw new Error(`identity file not found: ${path}`)
    const original = readFileSync(path, 'utf8')
    const mode = patch.mode ?? 'replace-section'
    const next = mode === 'append'
      ? this.appendSection(original, patch.section, patch.content)
      : this.replaceSection(original, patch.section, patch.content)

    mkdirSync(this.archiveDir, { recursive: true })
    const backup = join(this.archiveDir, `${patch.file}-identity-${stamp(this.now())}.md`)
    copyFileSync(path, backup)

    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, next, 'utf8')
    renameSync(temp, path)
    return { file: patch.file, path, backup }
  }

  private pathFor(file: IdentityFile): string {
    const resolvePath = FILES[file]
    if (!resolvePath) throw new Error(`unknown identity file: ${file}`)
    return resolvePath(this.agentDir)
  }

  private replaceSection(text: string, section: string, content: string): string {
    const lines = text.split('\n')
    const heading = `## ${section}`
    const start = lines.findIndex(line => line.trim() === heading)
    if (start < 0) throw new Error(`identity section not found: ${section}`)

    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^#{1,6}\s+/.test(lines[index]!)) {
        end = index
        break
      }
    }

    const body = content.split('\n')
    const before = lines.slice(0, start + 1)
    const after = lines.slice(end)
    return [...before, '', ...body, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n')
  }

  private appendSection(text: string, section: string, content: string): string {
    if (text.split('\n').some(line => line.trim() === `## ${section}`)) {
      throw new Error(`identity section already exists: ${section}`)
    }
    return `${text.trimEnd()}\n\n## ${section}\n\n${content.trim()}\n`
  }
}
