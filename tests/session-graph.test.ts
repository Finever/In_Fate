import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { SessionGraph } from '../src/graph/links.ts'

function graphIn(dir: string): SessionGraph {
  return new SessionGraph(new EventStore(join(dir, 'workspace.jsonl')))
}

test('连接图：创建、权限、去重、关闭与重载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-graph-'))
  try {
    const graph = graphIn(dir)
    const peer = graph.create({ from: 's1', to: 's2' })

    assert.equal(peer.relation, 'peer')
    assert.equal(peer.status, 'active')
    assert.equal(graph.canRead('s1', 's2'), true)
    assert.equal(graph.canRead('s2', 's1'), true)
    assert.equal(graph.canMessage('s1', 's2'), true)
    assert.equal(graph.canMessage('s2', 's1'), true)

    const duplicate = graph.create({ from: 's1', to: 's2' })
    assert.equal(duplicate.linkId, peer.linkId)

    const handoff = graph.create({ from: 's1', to: 's3', relation: 'handoff' })
    assert.equal(handoff.permissions.from.message, true)
    assert.equal(handoff.permissions.to.message, false)
    assert.equal(graph.canMessage('s1', 's3'), true)
    assert.equal(graph.canMessage('s3', 's1'), false)

    const reference = graph.create({ from: 's1', to: 's4', relation: 'reference' })
    assert.equal(graph.canRead('s4', 's1'), true)
    assert.equal(graph.canRead('s1', 's4'), false)
    assert.equal(graph.canMessage('s1', 's4'), false)

    const closed = graph.close(peer.linkId, 'user', 'done')
    assert.equal(closed?.status, 'closed')
    assert.equal(graph.canMessage('s1', 's2'), false)
    assert.equal(graph.links('s1', { includeClosed: false }).some(link => link.linkId === peer.linkId), false)
    assert.equal(graph.get(peer.linkId)?.closeReason, 'done')

    // 新实例从 workspace 事件流重建。
    const reloaded = graphIn(dir)
    assert.equal(reloaded.get(peer.linkId)?.status, 'closed')
    assert.equal(reloaded.links().length, 3)
    assert.equal(reloaded.snapshot().active, 2)
    assert.equal(reloaded.snapshot().closed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('连接图拒绝自连和非法 sessionId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-graph-bad-'))
  try {
    const graph = graphIn(dir)
    assert.throws(() => graph.create({ from: 's1', to: 's1' }), /itself/)
    assert.throws(() => graph.create({ from: 's1', to: '../evil' }), /unsafe/)
    assert.throws(() => graph.create({ from: 's1', to: 's2', relation: 'boss' as never }), /unknown link relation/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
