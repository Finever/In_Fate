/**
 * 记忆能力位：按会话授权，不按主/子层级。
 *
 * 角色只是默认模板；用户可以随时把任意会话提升/降级。
 *
 * @module if/memory/access
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type MemoryScope = 'shared' | 'identity' | 'private'
export type MemoryRole = 'steward' | 'worker' | 'observer' | 'private'

export interface MemoryGrant {
  readonly read: ReadonlySet<MemoryScope>
  readonly write: ReadonlySet<MemoryScope>
  readonly propose: ReadonlySet<MemoryScope>
}

export interface MemorySessionLike {
  readonly createdBy?: string
  readonly kind?: 'user' | 'agent'
}

const SCOPES: Record<MemoryRole, MemoryGrant> = {
  steward: {
    read: new Set(['shared', 'identity', 'private']),
    write: new Set(['shared']),
    propose: new Set(['shared', 'identity']),
  },
  worker: {
    read: new Set(['shared']),
    write: new Set(),
    propose: new Set(['shared', 'identity']),
  },
  observer: {
    read: new Set(['shared']),
    write: new Set(),
    propose: new Set(),
  },
  private: {
    read: new Set(['private']),
    write: new Set(['private']),
    propose: new Set(),
  },
}

const ROLES = new Set<MemoryRole>(['steward', 'worker', 'observer', 'private'])

export class MemoryAccess {
  private readonly file: string
  private readonly infoFor: (sessionId: string) => MemorySessionLike | undefined
  private readonly grants: Map<string, MemoryRole>

  constructor(
    file: string,
    infoFor: (sessionId: string) => MemorySessionLike | undefined,
  ) {
    this.file = file
    this.infoFor = infoFor
    this.grants = new Map()
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        for (const [sessionId, role] of Object.entries(raw)) {
          if (typeof role === 'string' && ROLES.has(role as MemoryRole)) {
            this.grants.set(sessionId, role as MemoryRole)
          }
        }
      } catch {
        // 授权文件坏掉时按默认模板走，不阻塞记忆读取。
      }
    }
  }

  roleFor(sessionId: string): MemoryRole {
    const explicit = this.grants.get(sessionId)
    if (explicit) return explicit
    const info = this.infoFor(sessionId)
    if (info?.kind === 'agent' || info?.createdBy === 'agent'
      || info?.createdBy?.startsWith('agent:')) {
      return 'worker'
    }
    return 'steward'
  }

  grantFor(sessionId: string): MemoryGrant {
    return SCOPES[this.roleFor(sessionId)]
  }

  canRead(sessionId: string, scope: MemoryScope): boolean {
    return this.grantFor(sessionId).read.has(scope)
  }

  canWrite(sessionId: string, scope: MemoryScope): boolean {
    return this.grantFor(sessionId).write.has(scope)
  }

  canPropose(sessionId: string, scope: MemoryScope): boolean {
    return this.grantFor(sessionId).propose.has(scope)
  }

  /** 只应由用户/App 调用；agent 不能自己给自己授权。 */
  grant(sessionId: string, role: MemoryRole): MemoryRole {
    if (!ROLES.has(role)) throw new Error(`unknown memory role: ${role}`)
    this.grants.set(sessionId, role)
    this.persist()
    return role
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(
      temp,
      `${JSON.stringify(Object.fromEntries(this.grants), null, 2)}\n`,
      'utf8',
    )
    renameSync(temp, this.file)
  }
}

export function memoryRoleGrant(role: MemoryRole): MemoryGrant {
  return SCOPES[role]
}
