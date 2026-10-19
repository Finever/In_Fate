/**
 * 审批注册表：驱动无关的中性决策。
 *
 * guard 返回 ask 时挂起，客户端 respond 后 resolve。
 * 取消、会话结束、重复 id 都同步拒绝，不留下永远挂着的请求。
 *
 * @module if/tools/approval
 */

import type {
  ApprovalRegistry,
  DispatchDecision,
  PendingApproval,
} from './types.ts'

export class InMemoryApprovalRegistry implements ApprovalRegistry {
  private readonly entries = new Map<string, PendingApproval>()
  /** 有 UI 时由驱动层设置：返回 undefined 表示不接管，继续等外部 respond。 */
  approvalHandler?: (entry: PendingApproval) => Promise<DispatchDecision> | undefined

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

    if (entry.signal) {
      const onAbort = (): void => {
        if (!this.entries.has(entry.approvalId)) return
        this.entries.delete(entry.approvalId)
        entry.resolve({ approved: false, reason: 'aborted' })
      }
      entry.signal.addEventListener('abort', onAbort, { once: true })
    }

    const pending = this.approvalHandler?.(entry)
    if (pending) {
      void pending
        .then(decision => this.respond(entry.approvalId, decision))
        .catch(() => this.respond(entry.approvalId, { approved: false, reason: 'approval failed' }))
    }

    return true
  }

  respond(approvalId: string, decision: DispatchDecision): boolean {
    const entry = this.entries.get(approvalId)
    if (!entry) return false
    this.entries.delete(approvalId)
    entry.resolve(decision)
    return true
  }

  pending(): readonly PendingApproval[] {
    return [...this.entries.values()]
  }

  cancelBySession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue
      this.entries.delete(id)
      entry.resolve({ approved: false, reason: 'session cancelled' })
    }
  }
}
