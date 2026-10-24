/**
 * 记忆提议：worker 不直写 detail / identity，只提交 proposal。
 *
 * detail proposal 由 MemoryStore 落库；identity proposal 由 MemoryIdentityStore
 * 做受控 section 替换/追加。proposal 本身是普通 JSON 文件。
 *
 * @module if/memory/proposals
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IdentityApplyResult, IdentityPatch } from './identity.ts'
import { MemoryIdentityStore } from './identity.ts'
import type { MemoryAddInput, MemoryEntry, MemoryStore } from './store.ts'

export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface MemoryProposal {
  readonly kind: 'detail' | 'identity'
  readonly proposalId: string
  readonly target: string
  readonly sourceSession: string
  readonly reason?: string
  /** detail proposal */
  readonly entry?: MemoryAddInput
  /** identity proposal */
  readonly identity?: IdentityPatch
  readonly status: ProposalStatus
  readonly createdAt: string
  readonly resolvedAt?: string
  readonly resolvedBy?: string
  readonly resultId?: string
}

export interface ProposeInput {
  readonly target: string
  readonly sourceSession: string
  readonly entry: MemoryAddInput
  readonly reason?: string
  readonly now?: Date
}

export interface ProposeIdentityInput {
  readonly target: string
  readonly sourceSession: string
  readonly identity: IdentityPatch
  readonly reason?: string
  readonly now?: Date
}

export type MemoryAcceptResult =
  | { readonly kind: 'detail'; readonly entry: MemoryEntry }
  | { readonly kind: 'identity'; readonly result: IdentityApplyResult }

export class MemoryProposalStore {
  readonly root: string
  private readonly now: () => Date
  private readonly onWrite?: () => void

  constructor(root: string, now: () => Date = () => new Date(), onWrite?: () => void) {
    this.root = join(root, 'proposals')
    this.now = now
    if (onWrite) this.onWrite = onWrite
  }

  propose(input: ProposeInput): MemoryProposal {
    return this.writeNew({
      kind: 'detail',
      target: input.target,
      sourceSession: input.sourceSession,
      ...(input.reason ? { reason: input.reason } : {}),
      entry: input.entry,
      status: 'pending',
      createdAt: (input.now ?? this.now()).toISOString(),
    })
  }

  proposeIdentity(input: ProposeIdentityInput): MemoryProposal {
    const expected = `identity:${input.identity.file}`
    if (input.target !== expected) {
      throw new Error(`identity target mismatch: ${input.target} vs ${expected}`)
    }
    return this.writeNew({
      kind: 'identity',
      target: input.target,
      sourceSession: input.sourceSession,
      ...(input.reason ? { reason: input.reason } : {}),
      identity: input.identity,
      status: 'pending',
      createdAt: (input.now ?? this.now()).toISOString(),
    })
  }

  list(status?: ProposalStatus): MemoryProposal[] {
    if (!existsSync(this.root)) return []
    const out: MemoryProposal[] = []
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue
      try {
        const proposal = this.normalize(
          JSON.parse(readFileSync(join(this.root, name), 'utf8')) as MemoryProposal,
        )
        if (!status || proposal.status === status) out.push(proposal)
      } catch {
        // 坏 proposal 不阻塞列表
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async accept(
    proposalId: string,
    store: MemoryStore,
    identityStore?: MemoryIdentityStore,
    resolvedBy = 'user',
  ): Promise<MemoryAcceptResult> {
    const proposal = this.get(proposalId)
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`)
    if (proposal.status === 'accepted' && proposal.kind === 'detail' && proposal.resultId) {
      const doc = store.read(proposal.target)
      const entry = doc.entries.find(item => item.id === proposal.resultId)
      if (entry) return { kind: 'detail', entry }
    }
    if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`)

    if (proposal.kind === 'identity') {
      if (!identityStore) throw new Error('identity memory is not configured')
      if (!proposal.identity) throw new Error('identity proposal has no patch')
      const result = identityStore.apply(proposal.identity)
      this.write({
        ...proposal,
        status: 'accepted',
        resolvedAt: this.now().toISOString(),
        resolvedBy,
        resultId: `identity:${result.file}#${proposal.identity.section}`,
      })
      return { kind: 'identity', result }
    }

    if (!proposal.entry) throw new Error('detail proposal has no entry')
    const entry = await store.add(proposal.target, proposal.entry)
    this.write({
      ...proposal,
      status: 'accepted',
      resolvedAt: this.now().toISOString(),
      resolvedBy,
      resultId: entry.id,
    })
    return { kind: 'detail', entry }
  }

  reject(proposalId: string, resolvedBy = 'user'): MemoryProposal {
    const proposal = this.get(proposalId)
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`)
    if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`)
    const next: MemoryProposal = {
      ...proposal,
      status: 'rejected',
      resolvedAt: this.now().toISOString(),
      resolvedBy,
    }
    this.write(next)
    return next
  }

  get(proposalId: string): MemoryProposal | undefined {
    try {
      return this.normalize(
        JSON.parse(readFileSync(join(this.root, `${proposalId}.json`), 'utf8')) as MemoryProposal,
      )
    } catch {
      return undefined
    }
  }

  private writeNew(input: Omit<MemoryProposal, 'proposalId'>): MemoryProposal {
    const proposal: MemoryProposal = {
      ...input,
      proposalId: `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    }
    this.write(proposal)
    return proposal
  }

  private normalize(proposal: MemoryProposal): MemoryProposal {
    if (proposal.kind === 'detail' || proposal.kind === 'identity') return proposal
    return {
      ...proposal,
      kind: proposal.target?.startsWith('identity:') ? 'identity' : 'detail',
    }
  }

  private write(proposal: MemoryProposal): void {
    mkdirSync(this.root, { recursive: true })
    const path = join(this.root, `${proposal.proposalId}.json`)
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
    this.onWrite?.()
  }
}
