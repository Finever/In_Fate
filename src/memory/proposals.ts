/**
 * 记忆提议：worker 不直写 detail，只提交 proposal。
 *
 * proposal 是普通 JSON 文件，等待用户/有写权限的会话审阅后由 MemoryStore 落库。
 *
 * @module if/memory/proposals
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryAddInput, MemoryEntry, MemoryStore } from './store.ts'

export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface MemoryProposal {
  readonly proposalId: string
  readonly target: string
  readonly sourceSession: string
  readonly reason?: string
  readonly entry: MemoryAddInput
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

export class MemoryProposalStore {
  readonly root: string
  private readonly now: () => Date

  constructor(root: string, now: () => Date = () => new Date()) {
    this.root = join(root, 'proposals')
    this.now = now
  }

  propose(input: ProposeInput): MemoryProposal {
    mkdirSync(this.root, { recursive: true })
    const proposalId = `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const proposal: MemoryProposal = {
      proposalId,
      target: input.target,
      sourceSession: input.sourceSession,
      ...(input.reason ? { reason: input.reason } : {}),
      entry: input.entry,
      status: 'pending',
      createdAt: (input.now ?? this.now()).toISOString(),
    }
    this.write(proposal)
    return proposal
  }

  list(status?: ProposalStatus): MemoryProposal[] {
    if (!existsSync(this.root)) return []
    const out: MemoryProposal[] = []
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue
      try {
        const proposal = JSON.parse(readFileSync(join(this.root, name), 'utf8')) as MemoryProposal
        if (!status || proposal.status === status) out.push(proposal)
      } catch {
        // 坏 proposal 不阻塞列表
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async accept(proposalId: string, store: MemoryStore, resolvedBy = 'user'): Promise<MemoryEntry> {
    const proposal = this.get(proposalId)
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`)
    if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`)
    const entry = await store.add(proposal.target, proposal.entry)
    this.write({
      ...proposal,
      status: 'accepted',
      resolvedAt: this.now().toISOString(),
      resolvedBy,
      resultId: entry.id,
    })
    return entry
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
      return JSON.parse(
        readFileSync(join(this.root, `${proposalId}.json`), 'utf8'),
      ) as MemoryProposal
    } catch {
      return undefined
    }
  }

  private write(proposal: MemoryProposal): void {
    mkdirSync(this.root, { recursive: true })
    const path = join(this.root, `${proposal.proposalId}.json`)
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  }
}
