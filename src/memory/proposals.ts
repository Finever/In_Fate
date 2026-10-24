/**
 * 记忆提议：worker 不直写 detail / identity，只提交 proposal。
 *
 * detail proposal 由 MemoryStore 落库；identity proposal 由 MemoryIdentityStore
 * 做受控 section 替换/追加。proposal 本身是普通 JSON 文件。
 *
 * @module if/memory/proposals
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IdentityApplyResult, IdentityPatch } from './identity.ts'
import type { IdentityStoreLike } from './identity.ts'
import type { MemoryAddInput, MemoryEntry, MemoryStore } from './store.ts'

/** `applying` 是身份写入的两阶段状态：先记意图，再落文件。 */
export type ProposalStatus = 'pending' | 'applying' | 'accepted' | 'rejected'

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
  /** identity proposal：写入前后全文指纹，用于崩溃后判断是否已落盘 */
  readonly beforeHash?: string
  readonly afterHash?: string
  readonly resultPath?: string
  readonly backupPath?: string
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
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
        // `applying` 是未完成状态：崩溃后它需要出现在待处理列表里，
        // 用户点 accept 会按指纹判断该补写还是已经落盘。
        if (
          !status
          || proposal.status === status
          || (status === 'pending' && proposal.status === 'applying')
        ) {
          out.push(proposal)
        }
      } catch {
        // 坏 proposal 不阻塞列表
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async accept(
    proposalId: string,
    store: MemoryStore,
    identityStore?: IdentityStoreLike,
    resolvedBy = 'user',
  ): Promise<MemoryAcceptResult> {
    const proposal = this.get(proposalId)
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`)
    if (proposal.status === 'accepted' && proposal.kind === 'detail' && proposal.resultId) {
      const doc = store.read(proposal.target)
      const entry = doc.entries.find(item => item.id === proposal.resultId)
      if (entry) return { kind: 'detail', entry }
    }
    if (proposal.status === 'accepted' && proposal.kind === 'identity' && proposal.identity) {
      return {
        kind: 'identity',
        result: {
          file: proposal.identity.file,
          path: proposal.resultPath ?? (identityStore?.path(proposal.identity.file) ?? ''),
          backup: proposal.backupPath ?? '',
        },
      }
    }

    if (proposal.kind === 'identity') {
      if (!identityStore) throw new Error('identity memory is not configured')
      if (!proposal.identity) throw new Error('identity proposal has no patch')
      return this.acceptIdentity(proposal, identityStore, resolvedBy)
    }
    if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`)

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

  /**
   * 身份写入的两阶段接受。
   *
   * 先写 `applying` + 前后指纹，再改文件，最后写 `accepted`。如果进程死在
   * 改文件之后、写 accepted 之前，重试时用 afterHash 认出“已经落过”，不会
   * 对 append 模式重复追加；如果文件在 applying 期间被外部改过，拒绝自动
   * 处理，留给人判断。
   */
  private async acceptIdentity(
    proposal: MemoryProposal,
    identityStore: IdentityStoreLike,
    resolvedBy: string,
  ): Promise<MemoryAcceptResult> {
    const patch = proposal.identity!
    const currentHash = (): string => hashText(identityStore.read(patch.file))

    if (proposal.status === 'applying') {
      if (proposal.afterHash && currentHash() === proposal.afterHash) {
        return this.finishIdentity(
          proposal,
          proposal.resultPath ?? identityStore.path(patch.file),
          proposal.backupPath ?? '',
          resolvedBy,
        )
      }
      if (proposal.beforeHash && currentHash() !== proposal.beforeHash) {
        throw new Error(
          `identity proposal ${proposal.proposalId} target changed while applying; resolve manually`,
        )
      }
    } else if (proposal.status !== 'pending') {
      throw new Error(`proposal already ${proposal.status}`)
    }

    const preview = identityStore.preview(patch)
    const beforeHash = hashText(preview.before)
    const afterHash = hashText(preview.after)
    if (proposal.status === 'applying' && proposal.beforeHash && beforeHash !== proposal.beforeHash) {
      throw new Error(
        `identity proposal ${proposal.proposalId} target changed while applying; resolve manually`,
      )
    }

    const applying: MemoryProposal = {
      ...proposal,
      status: 'applying',
      beforeHash,
      afterHash,
      resultPath: preview.path,
    }
    this.write(applying)

    let result: IdentityApplyResult
    try {
      result = await identityStore.apply(patch)
    } catch (error) {
      // 上一次尝试可能已经写进去了（例如崩溃前 apply 成功、状态没落盘）。
      if (hashText(identityStore.read(patch.file)) === afterHash) {
        result = { file: patch.file, path: preview.path, backup: proposal.backupPath ?? '' }
      } else {
        throw error
      }
    }

    return this.finishIdentity(proposal, result.path, result.backup, resolvedBy, {
      ...applying,
      backupPath: result.backup,
    })
  }

  private finishIdentity(
    proposal: MemoryProposal,
    path: string,
    backup: string,
    resolvedBy: string,
    base: MemoryProposal = proposal,
  ): MemoryAcceptResult {
    const patch = proposal.identity!
    this.write({
      ...base,
      status: 'accepted',
      resolvedAt: this.now().toISOString(),
      resolvedBy,
      resultPath: path,
      backupPath: backup,
      resultId: `identity:${patch.file}#${patch.section}`,
    })
    return {
      kind: 'identity',
      result: { file: patch.file, path, backup },
    }
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
