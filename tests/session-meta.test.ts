import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { SessionMetaStore } from '../src/session/meta.ts'

test('会话分类与置顶写入 workspace 流，可重载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-session-meta-'))
  try {
    const store = new EventStore(join(dir, 'workspace.jsonl'))
    const meta = new SessionMetaStore(store, undefined, {
      now: () => new Date('2026-11-20T10:00:00.000Z'),
    })
    meta.set('s1', { category: ' 工作 ', pinned: true })
    meta.set('s1', { thinkingHead: ' 先复述目标，再给结论。 ', thinkingHeadEnabled: true })
    const current = meta.metaOf('s1')
    assert.equal(current?.category, '工作')
    assert.equal(current?.pinned, true)
    assert.equal(current?.thinkingHead, '先复述目标，再给结论。')
    assert.equal(current?.thinkingHeadEnabled, true)
    assert.deepEqual(meta.categories(), ['工作'])

    meta.set('s1', { category: null, pinned: false, thinkingHead: null })
    assert.equal(meta.metaOf('s1')?.category, undefined)
    assert.equal(meta.metaOf('s1')?.pinned, undefined)
    assert.equal(meta.metaOf('s1')?.thinkingHead, undefined)
    assert.equal(meta.metaOf('s1')?.thinkingHeadEnabled, undefined)

    meta.set('s2', { category: '游戏' })
    const reloaded = new SessionMetaStore(new EventStore(join(dir, 'workspace.jsonl')))
    assert.equal(reloaded.metaOf('s1')?.category, undefined)
    assert.equal(reloaded.metaOf('s2')?.category, '游戏')
    assert.deepEqual(reloaded.categories(), ['游戏'])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('会话分类长度受限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-session-meta-long-'))
  try {
    const meta = new SessionMetaStore(new EventStore(join(dir, 'workspace.jsonl')))
    assert.throws(
      () => meta.set('s1', { category: 'x'.repeat(41) }),
      /category too long/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})