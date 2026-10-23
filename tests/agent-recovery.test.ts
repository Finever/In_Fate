import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { repairAgentStream } from '../src/agents/recovery.ts'
import { EventStore } from '../src/core/store.ts'

test('孤儿 agent 流补 interrupted，且不重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-agent-recovery-'))
  try {
    const store = new EventStore(join(dir, 'agent-x.jsonl'))
    store.append({
      stream: 'agent:agent-x',
      actor: 'user',
      type: 'agent.requested',
      payload: { requestId: 'agent-x', preset: 'researcher', prompt: 'test', source: { session: 's' }, priority: 'normal' },
    })
    store.append({
      stream: 'agent:agent-x',
      actor: 'agent',
      type: 'agent.started',
      payload: { requestId: 'agent-x', preset: 'researcher' },
    })

    assert.equal(repairAgentStream(store), true)
    const last = store.read().at(-1)!
    assert.equal(last.type, 'agent.interrupted')
    assert.equal(last.payload.error, 'process restarted')
    assert.equal(repairAgentStream(store), false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
