import type { MemoryAccess, MemoryRole } from './access.ts'
import { agentPrincipal, type MemorySpace, type MemorySpaceRole, type MemorySpaceStore } from './space.ts'

export type MemorySpaceAction = 'read' | 'write' | 'propose'

const ACTION_RANK: Record<MemorySpaceRole, number> = {
  read: 1,
  propose: 2,
  write: 3,
}

function ceiling(role: MemoryRole, spaceRole: MemorySpaceRole): MemorySpaceRole | undefined {
  switch (role) {
    case 'steward':
      return spaceRole
    case 'worker':
      return spaceRole === 'write' ? 'propose' : spaceRole
    case 'observer':
    case 'private':
      return 'read'
    default:
      return undefined
  }
}

export class MemorySpaceAccess {
  private readonly spaces: MemorySpaceStore
  private readonly access: MemoryAccess
  private readonly agentIdFor: (sessionId: string) => string | undefined

  constructor(
    spaces: MemorySpaceStore,
    access: MemoryAccess,
    agentIdFor: (sessionId: string) => string | undefined,
  ) {
    this.spaces = spaces
    this.access = access
    this.agentIdFor = agentIdFor
  }

  roleFor(sessionId: string, spaceId: string): MemorySpaceRole | undefined {
    const agentId = this.agentIdFor(sessionId)
    if (!agentId) return undefined
    const spaceRole = this.spaces.roleForAgent(agentId, spaceId)
    if (!spaceRole) return undefined
    return ceiling(this.access.roleFor(sessionId), spaceRole)
  }

  can(sessionId: string, spaceId: string, action: MemorySpaceAction): boolean {
    const role = this.roleFor(sessionId, spaceId)
    if (!role) return false
    return ACTION_RANK[role] >= ACTION_RANK[action]
  }

  visibleSpaces(sessionId: string): readonly MemorySpace[] {
    const agentId = this.agentIdFor(sessionId)
    if (!agentId) return []
    return this.spaces.forAgent(agentId).filter(space => this.roleFor(sessionId, space.id) !== undefined)
  }

  /** 私域只给 owner agent 的 steward 会话自动推；shared 按成员和空间开关。 */
  canAutoPush(sessionId: string, spaceId: string): boolean {
    const agentId = this.agentIdFor(sessionId)
    if (!agentId) return false
    if (!this.can(sessionId, spaceId, 'read')) return false
    return this.spaces.canAutoPush(agentId, spaceId, this.access.roleFor(sessionId))
  }

  /** 给上下文表用：只给元数据，不给正文。 */
  describe(sessionId: string): Array<{
    id: string
    name: string
    kind: MemorySpace['kind']
    role: MemorySpaceRole
    autoPush: boolean
    description?: string
  }> {
    const agentId = this.agentIdFor(sessionId)
    if (!agentId) return []
    return this.spaces.forAgent(agentId).flatMap(space => {
      const role = this.roleFor(sessionId, space.id)
      if (!role) return []
      return [{
        id: space.id,
        name: space.name,
        kind: space.kind,
        role,
        autoPush: this.canAutoPush(sessionId, space.id),
        ...(space.description ? { description: space.description } : {}),
      }]
    })
  }
}
