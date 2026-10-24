import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { listAgentRuns, listSessions } from '../src/app/session.ts'

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
    assert.equal(agent?.lifecycle, 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('会话列表可按生命周期过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-lifecycle-list-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    createSession(dir, 'active-one', { createdBy: 'user' })
    createSession(dir, 'archived-one', { createdBy: 'user' })
    createSession(dir, 'deleted-one', { createdBy: 'user' })
    const states: Record<string, 'active' | 'archived' | 'deleted'> = {
      'active-one': 'active',
      'archived-one': 'archived',
      'deleted-one': 'deleted',
    }
    const lifecycle = (id: string): 'active' | 'archived' | 'deleted' => states[id] ?? 'active'

    assert.deepEqual(listSessions(dir, { lifecycle }).map(item => item.id), ['active-one'])
    assert.deepEqual(
      listSessions(dir, { lifecycle, includeArchived: true }).map(item => item.id).sort(),
      ['active-one', 'archived-one'],
    )
    assert.deepEqual(
      listSessions(dir, { lifecycle, includeArchived: true, includeDeleted: true })
        .map(item => item.id).sort(),
      ['active-one', 'archived-one', 'deleted-one'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('agent 终态列表也认生命周期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-agent-lifecycle-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 'agent-done.jsonl')
    const store = new EventStore(file)
    store.append({
      stream: 'agent:agent-done',
      actor: 'system',
      type: 'session.created',
      payload: { sessionId: 'agent-done', formatVersion: 2, createdBy: 'agent:researcher' },
    })
    store.append({
      stream: 'agent:agent-done',
      actor: 'agent',
      type: 'agent.completed',
      payload: { summary: 'done' },
    })

    assert.equal(listAgentRuns(dir).length, 1)
    assert.equal(listAgentRuns(dir)[0]?.lifecycle, 'active')
    assert.equal(listAgentRuns(dir, {
      lifecycle: () => 'archived',
    }).length, 0)
    assert.equal(listAgentRuns(dir, {
      lifecycle: () => 'archived',
      includeArchived: true,
    })[0]?.lifecycle, 'archived')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
