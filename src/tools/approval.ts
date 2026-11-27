import type {
  ApprovalRegistry,
  DispatchDecision,
  PendingApproval,
} from './types.ts'

export type ApprovalDecisionSource = 'user' | 'timeout' | 'abort' | 'cancel' | 'handler-failed' | 'restart'

export interface ApprovalAudit {
  asked?(entry: PendingApproval): void
  decided?(entry: PendingApproval, decision: DispatchDecision, source: ApprovalDecisionSource): void
}

export class InMemoryApprovalRegistry implements ApprovalRegistry {
  private readonly entries = new Map<string, PendingApproval>()
  /** 有 UI 时由驱动层设置：返回 undefined 表示不接管，继续等外部 respond。 */
  approvalHandler?: (entry: PendingApproval) => Promise<DispatchDecision> | undefined
  /** 会话写者接进来后，把 asked/decided 落事件。 */
  audit?: ApprovalAudit

  request(entry: PendingApproval): boolean {
    if (this.entries.has(entry.approvalId)) {
      entry.resolve({ approved: false, reason: 'duplicate approval id' })
      return false
    }
    if (entry.signal?.aborted) {
      entry.resolve({ approved: false, reason: 'aborted' })
      return false
    }

    this.entries.set(entry.approvalId, entry)

    // 先写审计再挂起；审计写不进去就失败关闭，绝不留“内存有、磁盘没有”的审批。
    try {
      this.audit?.asked?.(entry)
    } catch {
      this.entries.delete(entry.approvalId)
      entry.resolve({ approved: false, reason: 'approval audit failed' })
      return false
    }

    if (entry.signal) {
      const onAbort = (): void => {
        this.settle(entry, { approved: false, reason: 'aborted' }, 'abort')
      }
      entry.signal.addEventListener('abort', onAbort, { once: true })
    }

    const pending = this.approvalHandler?.(entry)
    if (pending) {
      void pending
        .then(decision => this.respond(entry.approvalId, decision))
        .catch(() => this.respond(
          entry.approvalId,
          { approved: false, reason: 'approval handler failed' },
          'handler-failed',
        ))
    }

    return true
  }

  respond(
    approvalId: string,
    decision: DispatchDecision,
    source?: ApprovalDecisionSource,
  ): boolean {
    const entry = this.entries.get(approvalId)
    if (!entry) return false
    const inferred = decision.reason?.includes('timeout')
      ? 'timeout'
      : source ?? 'user'
    this.settle(entry, decision, inferred)
    return true
  }

  pending(): readonly PendingApproval[] {
    return [...this.entries.values()]
  }

  cancelBySession(sessionId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.sessionId !== sessionId) continue
      this.settle(entry, { approved: false, reason: 'session cancelled' }, 'cancel')
    }
  }

  private settle(
    entry: PendingApproval,
    decision: DispatchDecision,
    source: ApprovalDecisionSource,
  ): void {
    if (!this.entries.has(entry.approvalId)) return
    this.entries.delete(entry.approvalId)
    // 已决审计失败不能把等待方永远挂住；先记录失败，再 resolve。
    try {
      this.audit?.decided?.(entry, decision, source)
    } catch {
      // 事件日志不可写时仍让执行器拿到拒绝/决定，避免死锁。
    }
    entry.resolve(decision)
  }
}
