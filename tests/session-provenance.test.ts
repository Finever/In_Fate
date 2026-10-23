import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { listSessions } from '../src/app/session.ts'

function createSession(dir: string, id: string, payload: Record<string, unknown>): void {
  const file = join(dir, 'sessions', `${id}.jsonl`)
  const store = new EventStore(file)
  store.append({
    stream: `session:${id}`,
    actor: 'system',
    type: 'session.created',
    payload: { sessionId: id, formatVersion: 2, ...payload },
  })
}

test('会话列表带创建者，但仍是扁平列表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-provenance-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    createSession(dir, 'user-session', { createdBy: 'user', reason: '用户打开' })
    createSession(dir, 'agent-session', {
      createdBy: 'agent:researcher',
      createdFrom: { sessionId: 'user-session' },
      reason: '并行调研',
    })

    // 旧 agent 流没有 session.created，仍由 listAgentRuns 单独展示。
    const legacy = new EventStore(join(dir, 'sessions', 'agent-legacy.jsonl'))
    legacy.append({ stream: 'agent:agent-legacy', actor: 'agent', type: 'agent.requested', payload: {} })

    const sessions = listSessions(dir)
    assert.deepEqual(sessions.map(item => item.id).sort(), ['agent-session', 'user-session'])

    const user = sessions.find(item => item.id === 'user-session')
    assert.equal(user?.kind, 'user')
    assert.equal(user?.createdBy, 'user')
    assert.equal(user?.reason, '用户打开')

    const agent = sessions.find(item => item.id === 'agent-session')
    assert.equal(agent?.kind, 'agent')
    assert.equal(agent?.createdBy, 'agent:researcher')
    assert.deepEqual(agent?.createdFrom, { sessionId: 'user-session' })
    assert.equal(agent?.reason, '并行调研')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
