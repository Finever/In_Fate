import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { MemorySummaryStore, type MemorySummaryGenerator } from '../src/memory/summary.ts'
import { MemorySummaryWorker } from '../src/memory/summary-worker.ts'

test('摘要 worker：写入入队、未变跳过、变更后重算', async () => {
  const root = mkdtempSync(join(tmpdir(), 'if-summary-worker-'))
  try {
    ensureMemoryLayout(root)
    const store = new MemoryStore(root)
    let calls = 0
    const generator: MemorySummaryGenerator = {
      name: 'fake-model',
      async generateDocument({ entries }) {
        calls += 1
        return entries.map(entry => ({
          entryId: entry.id,
          title: `标题 ${entry.id}`,
          summary: `模型摘要 ${entry.content}`,
          keywords: ['测试'],
        }))
      },
    }
    const summaries = new MemorySummaryStore({ root, store, generator })
    const worker = new MemorySummaryWorker({ summaries })
    await store.add('detail:测试/队列', {
      content: '第一次写入',
      tag: '确信',
      introduction: '测试',
    })
    assert.equal(worker.enqueue('detail:测试/队列'), true)
    await worker.waitIdle()
    assert.equal(calls, 1)
    assert.equal(worker.status().jobs[0]?.status, 'done')

    assert.equal(worker.enqueue('detail:测试/队列'), false)
    await worker.waitIdle()
    assert.equal(calls, 1)
    assert.equal(worker.status().jobs[0]?.status, 'skipped')

    await store.add('detail:测试/队列', { content: '第二次写入', tag: '可信' })
    assert.equal(worker.enqueue('detail:测试/队列'), true)
    await worker.waitIdle()
    assert.equal(calls, 2)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('摘要 worker：没有生成器时不排队', () => {
  const root = mkdtempSync(join(tmpdir(), 'if-summary-worker-none-'))
  try {
    ensureMemoryLayout(root)
    const store = new MemoryStore(root)
    const worker = new MemorySummaryWorker({
      summaries: new MemorySummaryStore({ root, store }),
    })
    assert.equal(worker.canGenerate, false)
    assert.equal(worker.enqueue('detail:测试/无模型'), false)
    assert.equal(worker.status().generator, false)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
