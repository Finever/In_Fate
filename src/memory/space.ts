/**
 * 记忆空间注册表：私域、共有空间、成员与继承。
 *
 * 落盘 `<memoryRoot>/spaces.json`；目录仍在 `detail/_<dir>/` 下，注册表只加
 * 归属和 ACL，不搬记忆文件。私域只允许对应 agent 读写；共有空间按成员表授权。
 *
 * @module if/memory/space
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from '../core/lock.ts'

export type MemorySpaceKind = 'private' | 'shared' | 'user'
export type MemorySpaceRole = 'read' | 'write' | 'propose'

export interface MemorySpaceMember {
  /** user / agent:<id> / group:<id>；group 先留口，不实现。 */
  readonly principal: string
  readonly role: MemorySpaceRole
  /** 从哪个父 agent 继承来的；手加成员不填。 */
  readonly inheritedFrom?: string
  /** 继承成员可由子 agent 自己移除。 */
  readonly canRemove?: boolean
}

export interface MemorySpace {
  readonly id: string
  readonly name: string
  readonly kind: MemorySpaceKind
  /** private: agent:<id>；shared: user 或 agent:<id>；user: user */
  readonly owner: string
  readonly members: readonly MemorySpaceMember[]
  readonly autoPush: boolean
  readonly description?: string
  /** 落盘目录名，默认 `_<id>`。 */
  readonly dir?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MemorySpacesDocument {
  readonly version: 1
  readonly migratedAt?: string
  readonly spaces: readonly MemorySpace[]
}

const KINDS = new Set<MemorySpaceKind>(['private', 'shared', 'user'])
const ROLES = new Set<MemorySpaceRole>(['read', 'write', 'propose'])
const BAD_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/
const PRINCIPAL = /^(user|agent:[^:\s]+|group:[^:\s]+)$/

function assertSegment(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || BAD_SEGMENT.test(value)
    || /[. ]$/.test(value)
  ) {
    throw new Error(`invalid memory space ${label}: ${JSON.stringify(value)}`)
  }
}

function assertPrincipal(value: string, label: string): string {
  if (!PRINCIPAL.test(value)) {
    throw new Error(`invalid memory space ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

export function agentPrincipal(agentId: string): string {
  return `agent:${agentId}`
}

/** 空间落盘目录：私有/用户空间带 `_` 前缀，共有空间直接用 id；可显式覆盖。 */
export function spaceDir(space: MemorySpace): string {
  return space.dir ?? (space.kind === 'shared' ? space.id : `_${space.id}`)
}

export function agentIdOfPrincipal(principal: string): string | undefined {
  return principal.startsWith('agent:') ? principal.slice('agent:'.length) : undefined
}

export function validateMemorySpace(space: MemorySpace): void {
  assertSegment(space.id, 'id')
  if (typeof space.name !== 'string' || space.name.trim().length === 0) {
    throw new Error('memory space needs a name')
  }
  if (!KINDS.has(space.kind)) throw new Error(`invalid memory space kind: ${String(space.kind)}`)
  assertPrincipal(space.owner, 'owner')
  if (space.kind === 'private' && !space.owner.startsWith('agent:')) {
    throw new Error('private memory space owner must be agent:<id>')
  }
  if (space.kind === 'user' && space.owner !== 'user') {
    throw new Error('user memory space owner must be user')
  }
  if (space.dir !== undefined) assertSegment(space.dir, 'dir')
  if (space.description !== undefined && typeof space.description !== 'string') {
    throw new Error('memory space description must be a string')
  }
  const seen = new Set<string>()
  for (const member of space.members) {
    assertPrincipal(member.principal, 'member principal')
    if (!ROLES.has(member.role)) {
      throw new Error(`invalid memory space member role: ${String(member.role)}`)
    }
    if (seen.has(member.principal)) {
      throw new Error(`duplicate memory space member: ${member.principal}`)
    }
    seen.add(member.principal)
  }
}

function readDocument(file: string): { doc: MemorySpacesDocument; error?: string } {
  if (!existsSync(file)) return { doc: { version: 1, spaces: [] } }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<MemorySpacesDocument>
    if (raw.version !== 1 || !Array.isArray(raw.spaces)) {
      return { doc: { version: 1, spaces: [] }, error: `spaces.json 版本不合法：${file}` }
    }
    const spaces = raw.spaces.map(space => {
      validateMemorySpace(space)
      return space
    })
    return {
      doc: {
        version: 1,
        ...(raw.migratedAt ? { migratedAt: raw.migratedAt } : {}),
        spaces,
      },
    }
  } catch (error) {
    return {
      doc: { version: 1, spaces: [] },
      error: `spaces.json 读不出来：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function memberMatches(member: MemorySpaceMember, agentId: string): boolean {
  return member.principal === agentPrincipal(agentId)
}

const ROLE_RANK: Record<MemorySpaceRole, number> = {
  read: 1,
  propose: 2,
  write: 3,
}

export function maxRole(roles: readonly MemorySpaceRole[]): MemorySpaceRole | undefined {
  let best: MemorySpaceRole | undefined
  for (const role of roles) {
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role
  }
  return best
}

export class MemorySpaceStore {
  readonly file: string
  private doc: MemorySpacesDocument
  private readonly loadError?: string
  private readonly now: () => Date

  constructor(root: string, options: { now?: () => Date } = {}) {
    this.file = join(root, 'spaces.json')
    this.now = options.now ?? (() => new Date())
    const loaded = readDocument(this.file)
    this.doc = loaded.doc
    this.loadError = loaded.error
  }

  list(): readonly MemorySpace[] {
    return this.doc.spaces
  }

  get(id: string): MemorySpace | undefined {
    return this.doc.spaces.find(space => space.id === id)
  }

  /** agent 能看见的空间：自己的 private + 自己是成员的 shared。 */
  forAgent(agentId: string): readonly MemorySpace[] {
    return this.doc.spaces.filter(space => {
      if (space.kind === 'user') return false
      if (space.kind === 'private') return space.owner === agentPrincipal(agentId)
      return space.members.some(member => memberMatches(member, agentId))
    })
  }

  roleForAgent(agentId: string, spaceId: string): MemorySpaceRole | undefined {
    const space = this.get(spaceId)
    if (!space || space.kind === 'user') return undefined
    if (space.kind === 'private') {
      return space.owner === agentPrincipal(agentId) ? 'write' : undefined
    }
    const member = space.members.find(item => memberMatches(item, agentId))
    return member?.role
  }

  /** 是否可以自动推送；显式查询不受这个限制。 */
  canAutoPush(agentId: string, spaceId: string, sessionRole: string): boolean {
    const space = this.get(spaceId)
    if (!space || !space.autoPush) return false
    if (space.kind === 'private') {
      return space.owner === agentPrincipal(agentId) && sessionRole === 'steward'
    }
    if (space.kind === 'shared') {
      return Boolean(space.members.find(member => memberMatches(member, agentId)))
    }
    return false
  }

  async upsert(space: MemorySpace): Promise<MemorySpace> {
    validateMemorySpace(space)
    await this.mutate(doc => {
      const next = { ...space, updatedAt: this.now().toISOString() }
      const index = doc.spaces.findIndex(item => item.id === space.id)
      const spaces = [...doc.spaces]
      if (index >= 0) spaces[index] = next
      else {
        if (doc.spaces.some(item => item.id === space.id)) {
          throw new Error(`memory space already exists: ${space.id}`)
        }
        spaces.push(next)
      }
      return { ...doc, spaces }
    })
    return this.get(space.id)!
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate(doc => ({
      ...doc,
      spaces: doc.spaces.filter(space => space.id !== id),
    }))
  }

  async setAutoPush(id: string, autoPush: boolean): Promise<MemorySpace> {
    await this.mutate(doc => ({
      ...doc,
      spaces: doc.spaces.map(space => space.id === id
        ? { ...space, autoPush, updatedAt: this.now().toISOString() }
        : space),
    }))
    return this.get(id)!
  }

  async addMember(id: string, member: MemorySpaceMember): Promise<MemorySpace> {
    assertPrincipal(member.principal, 'member principal')
    if (!ROLES.has(member.role)) throw new Error(`invalid member role: ${String(member.role)}`)
    await this.mutate(doc => ({
      ...doc,
      spaces: doc.spaces.map(space => {
        if (space.id !== id) return space
        if (space.members.some(item => item.principal === member.principal)) return space
        return {
          ...space,
          members: [...space.members, member],
          updatedAt: this.now().toISOString(),
        }
      }),
    }))
    return this.get(id)!
  }

  async removeMember(id: string, principal: string): Promise<MemorySpace> {
    await this.mutate(doc => ({
      ...doc,
      spaces: doc.spaces.map(space => space.id === id
        ? {
          ...space,
          members: space.members.filter(member => member.principal !== principal),
          updatedAt: this.now().toISOString(),
        }
        : space),
    }))
    return this.get(id)!
  }

  /**
   * 衍生 agent 默认继承父级的 **shared** 空间成员；私域不继承。
   * 物化写入子 agent 的成员条目，带 inheritedFrom 便于 UI 标注和移除。
   */
  async inheritShared(
    parentAgentId: string,
    childAgentId: string,
    options: { enabled?: boolean } = {},
  ): Promise<number> {
    if (options.enabled === false) return 0
    if (parentAgentId === childAgentId) return 0
    let count = 0
    return this.mutate(doc => {
      const spaces = doc.spaces.map(space => {
        if (space.kind !== 'shared') return space
        const parentMember = space.members.find(member => memberMatches(member, parentAgentId))
        if (!parentMember) return space
        if (space.members.some(member => memberMatches(member, childAgentId))) return space
        count += 1
        return {
          ...space,
          members: [
            ...space.members,
            {
              principal: agentPrincipal(childAgentId),
              role: parentMember.role,
              inheritedFrom: parentAgentId,
              canRemove: true,
            },
          ],
          updatedAt: this.now().toISOString(),
        }
      })
      return { ...doc, spaces }
    }).then(() => count)
  }

  /** 扫 detail 下已存在的 `_` 目录，没登记的按 user 私域补一条；不搬文件。 */
  async migratePrivateDirs(detailDir: string): Promise<number> {
    if (!existsSync(detailDir)) return 0
    const existing = new Set(
      this.doc.spaces
        .filter(space => space.kind === 'user' || space.kind === 'private')
        .map(space => space.dir ?? `_${space.id}`),
    )
    const found: MemorySpace[] = []
    for (const entry of readdirSync(detailDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('_')) continue
      if (entry.name.startsWith('.')) continue
      if (existing.has(entry.name)) continue
      const id = entry.name.slice(1)
      if (!id) continue
      const now = this.now().toISOString()
      found.push({
        id,
        name: id,
        kind: 'user',
        owner: 'user',
        members: [],
        autoPush: false,
        dir: entry.name,
        description: '从旧私域目录迁移；映射 owner 后再决定归属',
        createdAt: now,
        updatedAt: now,
      })
    }
    if (found.length === 0) {
      return this.mutate(doc => ({ ...doc, migratedAt: this.now().toISOString() })).then(() => 0)
    }
    await this.mutate(doc => {
      const spaces = [...doc.spaces]
      for (const space of found) {
        if (!spaces.some(item => item.id === space.id)) spaces.push(space)
      }
      return { ...doc, spaces, migratedAt: this.now().toISOString() }
    })
    return found.length
  }

  private async mutate(
    fn: (doc: MemorySpacesDocument) => MemorySpacesDocument,
  ): Promise<boolean> {
    if (this.loadError) throw new Error(this.loadError)
    return withFileLock(this.file, () => {
      const current = readDocument(this.file)
      if (current.error) throw new Error(current.error)
      const next = fn(current.doc)
      writeDocument(this.file, next)
      this.doc = next
      return true
    })
  }
}

function writeDocument(file: string, doc: MemorySpacesDocument): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}
