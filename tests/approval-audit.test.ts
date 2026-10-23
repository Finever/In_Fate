import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryApprovalRegistry } from '../src/tools/approval.ts'
import type { DispatchDecision, PendingApproval } from '../src/tools/types.ts'

function entry(
  id: string,
  sessionId: string,
  resolve: (decision: DispatchDecision) => void,
): PendingApproval {
  return {
    approvalId: id,
    sessionId,
    toolCallId: `call-${id}`,
    toolName: 'bash',
    originalInput: { command: 'ls' },
    resolve,
  }
}

test('request/respond 写 asked 与 decided 审计', async () => {
  const registry = new InMemoryApprovalRegistry()
  const asked: string[] = []
  const decided: string[] = []
  registry.audit = {
    asked: item => asked.push(item.approvalId),
    decided: (item, decision, source) => decided.push(`${item.approvalId}:${decision.approved}:${source}`),
  }

  let resolveDecision!: (decision: DispatchDecision) => void
  const promise = new Promise<DispatchDecision>(resolve => {
    resolveDecision = resolve
  })
  assert.equal(registry.request(entry('a1', 's1', decision => resolveDecision(decision))), true)
  assert.deepEqual(asked, ['a1'])

  assert.equal(registry.respond('a1', { approved: true }), true)
  assert.deepEqual(await promise, { approved: true })
  assert.deepEqual(decided, ['a1:true:user'])
})

test('审计写入失败时拒绝请求', async () => {
  const registry = new InMemoryApprovalRegistry()
  registry.audit = { asked: () => { throw new Error('disk full') } }

  let resolveDecision!: (decision: DispatchDecision) => void
  const promise = new Promise<DispatchDecision>(resolve => {
    resolveDecision = resolve
  })
  assert.equal(registry.request(entry('a2', 's1', decision => resolveDecision(decision))), false)
  assert.deepEqual(await promise, { approved: false, reason: 'approval audit failed' })
})

test('取消会话写 cancel 来源', async () => {
  const registry = new InMemoryApprovalRegistry()
  const decided: string[] = []
  registry.audit = { decided: (_item, decision, source) => decided.push(`${decision.approved}:${source}`) }

  let resolveDecision!: (decision: DispatchDecision) => void
  const promise = new Promise<DispatchDecision>(resolve => {
    resolveDecision = resolve
  })
  registry.request(entry('a3', 's2', decision => resolveDecision(decision)))
  registry.cancelBySession('s2')
  await promise
  assert.deepEqual(decided, ['false:cancel'])
})
