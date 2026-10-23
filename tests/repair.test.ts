import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { repairInterruptedSession, settleInterruptedApprovals } from '../src/app/repair.ts'
import { EventStore } from '../src/core/store.ts'

function tempStore(): { dir: string; store: EventStore } {
  const dir = mkdtempSync(join(tmpdir(), 'if-repair-'))
  return { dir, store: new EventStore(join(dir, 'session.jsonl')) }
}

function append(store: EventStore, type: string, payload: Record<string, unknown>, actor = 'agent'): void {
  store.append({ stream: 'session:s', actor, type, payload })
}

test('未完成轮补 unknown 结果与 aborted turn.completed，且可重复调用', () => {
  const { dir, store } = tempStore()
  try {
    append(store, 'session.created', { formatVersion: 2 }, 'system')
    append(store, 'message.user', { text: '跑一下' }, 'user')
    append(store, 'tool.call', { callId: 'c1', call: 'bash', args: { command: 'ls' } })

    const first = repairInterruptedSession(store)
    assert.deepEqual(first, { closedTurn: true, unknownResults: 1 })

    const events = store.read()
    const result = events.find(event => event.type === 'tool.result')
    assert.equal(result?.payload.code, 'TOOL_OUTCOME_UNKNOWN')
    assert.equal(result?.payload.isError, true)
    assert.equal(events.at(-1)?.type, 'turn.completed')
    assert.equal(events.at(-1)?.payload.aborted, true)

    const before = events.length
    const second = repairInterruptedSession(store)
    assert.deepEqual(second, { closedTurn: false, unknownResults: 0 })
    assert.equal(store.read().length, before)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('已完成的轮不重复修', () => {
  const { dir, store } = tempStore()
  try {
    append(store, 'session.created', { formatVersion: 2 }, 'system')
    append(store, 'message.user', { text: '完成' }, 'user')
    append(store, 'tool.call', { callId: 'c1', call: 'read', args: {} })
    append(store, 'tool.result', { callId: 'c1', text: 'ok', isError: false }, 'tool')
    append(store, 'turn.completed', { steps: 1, aborted: false }, 'system')

    const before = store.read().length
    const result = repairInterruptedSession(store)
    assert.deepEqual(result, { closedTurn: false, unknownResults: 0 })
    assert.equal(store.read().length, before)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('重启后未决审批补 restart 拒绝，且不重复', () => {
  const { dir, store } = tempStore()
  try {
    append(store, 'session.created', { formatVersion: 2 }, 'system')
    append(store, 'approval.asked', {
      approvalId: 'a1',
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' },
    }, 'system')

    assert.deepEqual(settleInterruptedApprovals(store), { cancelled: 1 })
    const decided = store.read().find(event => event.type === 'approval.decided')
    assert.equal(decided?.payload.approvalId, 'a1')
    assert.equal(decided?.payload.source, 'restart')
    assert.deepEqual(settleInterruptedApprovals(store), { cancelled: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('只有 system 注入的尾巴不算未完成轮', () => {
  const { dir, store } = tempStore()
  try {
    append(store, 'session.created', { formatVersion: 2 }, 'system')
    append(store, 'message.system', { text: '子 agent 完成', mark: 'injection' }, 'system')

    const before = store.read().length
    const result = repairInterruptedSession(store)
    assert.deepEqual(result, { closedTurn: false, unknownResults: 0 })
    assert.equal(store.read().length, before)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
