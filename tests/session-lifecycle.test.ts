import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionWriter } from '../src/core/session-writer.ts'
import { EventStore } from '../src/core/store.ts'
import { SessionLifecycle } from '../src/session/lifecycle.ts'

test('生命周期：默认 active，归档可恢复，删除是终态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-lifecycle-'))
  const store = new EventStore(join(dir, 'workspace.jsonl'))
  const writer = SessionWriter.open(store)
  try {
    const lifecycle = new SessionLifecycle(store, writer)
    assert.equal(lifecycle.stateOf('s1'), 'active')
    assert.equal(lifecycle.canRun('s1'), true)
    assert.equal(lifecycle.canMessage('s1'), true)
    assert.equal(lifecycle.canRead('s1'), true)

    const archived = lifecycle.archive('s1', 'user', '做完了')
    assert.equal(archived.state, 'archived')
    assert.equal(lifecycle.canRun('s1'), false)
    assert.equal(lifecycle.canMessage('s1'), false)
    assert.equal(lifecycle.canRead('s1'), true)

    // 新实例从 workspace 流重放
    const reloaded = new SessionLifecycle(store)
    assert.equal(reloaded.stateOf('s1'), 'archived')
    assert.equal(reloaded.recordOf('s1')?.reason, '做完了')

    reloaded.unarchive('s1', 'user')
    assert.equal(reloaded.stateOf('s1'), 'active')

    reloaded.delete('s1', 'user', '不再需要')
    assert.equal(reloaded.stateOf('s1'), 'deleted')
    assert.equal(reloaded.canRead('s1'), false)
    assert.throws(() => reloaded.archive('s1'), /deleted/)
    assert.throws(() => reloaded.unarchive('s1'), /deleted/)
    assert.equal(reloaded.delete('s1').state, 'deleted')
  } finally {
    writer.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('生命周期事件写在 workspace 流，不碰会话流', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-lifecycle-stream-'))
  const workspace = new EventStore(join(dir, 'workspace.jsonl'))
  const writer = SessionWriter.open(workspace)
  try {
    const lifecycle = new SessionLifecycle(workspace, writer)
    lifecycle.archive('s1')
    const events = workspace.read()
    assert.equal(events.length, 1)
    assert.equal(events[0]?.stream, 'workspace:default')
    assert.equal(events[0]?.type, 'session.lifecycle')
    assert.equal(events[0]?.payload.sessionId, 's1')
    assert.equal(events[0]?.payload.state, 'archived')
  } finally {
    writer.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
