import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { UiIndex } from '../src/ui/index.ts'

function temp(): { dir: string; store: EventStore; db: string } {
  const dir = mkdtempSync(join(tmpdir(), 'if-ui-index-'))
  return { dir, store: new EventStore(join(dir, 'session.jsonl')), db: join(dir, 'ui.sqlite') }
}

function seed(store: EventStore): { resultId: string } {
  store.append({
    stream: 'session:s', actor: 'system', type: 'session.created', payload: { formatVersion: 2 },
  })
  store.append({
    stream: 'session:s', actor: 'user', type: 'message.user', payload: { text: '问题一' },
  })
  store.append({
    stream: 'session:s', actor: 'agent', type: 'tool.call',
    payload: { callId: 'c1', call: 'read', args: { file_path: 'a.txt' } },
  })
  const result = store.append({
    stream: 'session:s', actor: 'tool', type: 'tool.result',
    payload: { callId: 'c1', text: 'x'.repeat(1000), bytes: 1000, encoding: 'utf-8' },
  })
  store.append({
    stream: 'session:s', actor: 'agent', type: 'message.assistant', payload: { text: '回答一' },
  })
  store.append({
    stream: 'session:s', actor: 'system', type: 'turn.completed',
    payload: { steps: 2, usage: { input: 10, output: 5, cacheRead: 1 }, aborted: false, hitLimit: false },
  })
  store.append({
    stream: 'session:s', actor: 'user', type: 'message.user', payload: { text: '问题二' },
  })
  store.append({
    stream: 'session:s', actor: 'agent', type: 'message.assistant', payload: { text: '回答二' },
  })
  store.append({
    stream: 'session:s', actor: 'system', type: 'turn.completed',
    payload: { steps: 1, usage: { input: 2, output: 1, cacheRead: 0 }, aborted: false, hitLimit: false },
  })
  return { resultId: result.id }
}

test('SQLite 索引按轮分页并配对工具结果', () => {
  const { dir, store, db } = temp()
  try {
    seed(store)
    const index = UiIndex.open(db)
    index.sync(store)

    const latest = index.page('s', { limit: 1 })
    assert.equal(latest.turns, 1)
    assert.equal(latest.hasMoreBefore, true)
    assert.equal(latest.hasMoreAfter, false)
    assert.deepEqual(latest.items.map(item => item.kind), ['user', 'assistant', 'turn'])

    const first = index.page('s', { limit: 1, before: latest.nextBefore })
    assert.equal(first.turns, 1)
    assert.equal(first.hasMoreBefore, false)
    assert.equal(first.hasMoreAfter, true)
    const tool = first.items.find(item => item.kind === 'tool')
    assert.equal(tool?.tool?.status, 'ok')
    assert.match(tool!.tool!.result!.preview, /…/)

    const stats = index.stats('s', store)
    assert.equal(stats.events, 9)
    assert.equal(stats.turns, 2)
    assert.equal(stats.lastSeq, 8)
    index.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('索引持久化、增量同步与 prune 更新', () => {
  const { dir, store, db } = temp()
  try {
    const { resultId } = seed(store)
    const index = UiIndex.open(db)
    index.sync(store)
    index.close()

    // 追加 prune 事件后再同步
    store.append({
      stream: 'session:s', actor: 'system', type: 'compaction.pruned',
      payload: {
        items: [{
          eventId: resultId,
          preview: 'PREVIEW',
          ref: 'spill:0123456789abcdef0123456789abcdef01234567',
          beforeBytes: 1000,
          afterBytes: 10,
        }],
      },
    })

    const reopened = UiIndex.open(db)
    reopened.sync(store)
    const first = reopened.page('s', { limit: 1, before: reopened.page('s', { limit: 1 }).nextBefore })
    const tool = first.items.find(item => item.kind === 'tool')
    assert.equal(tool?.tool?.result?.preview, 'PREVIEW')
    assert.equal(tool?.tool?.result?.ref, 'spill:0123456789abcdef0123456789abcdef01234567')
    assert.equal(reopened.stats('s', store).pruned, 1)
    reopened.close()
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // Windows 偶尔晚一拍释放 sqlite 文件
    }
  }
})
