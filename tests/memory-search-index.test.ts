import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { MemorySearchIndex } from '../src/memory/search-index.ts'
import { MemoryStore } from '../src/memory/store.ts'

test('本地检索索引：中文子串、引号、domain/tag 过滤与增量标脏', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-search-'))
  const root = join(dir, 'memory')
  ensureMemoryLayout(root)
  const store = new MemoryStore(root, { timeZone: 'Asia/Shanghai' })
  const index = new MemorySearchIndex(root, store)
  try {
    await store.add('detail:环境/测试', {
      content: '触久喜欢在深夜写代码，窗外的月光落在键盘上。',
      tag: '确信',
      introduction: '测试记忆',
      quotes: [{ say: '窗外的月光落在键盘上', 'log-addr': '2026-11-06-sess-1-1' }],
    })
    index.markDirty()

    assert.equal(index.search('深夜').length, 1)
    assert.equal(index.search('触久')[0]?.id, '测试-0001')
    assert.equal(index.search('月光').length, 1)
    assert.equal(index.search('月光', { domain: '环境' }).length, 1)
    assert.equal(index.search('月光', { domain: '不存在' }).length, 0)
    assert.equal(index.search('月光', { tag: '有疑' }).length, 0)

    await store.add('detail:环境/测试', {
      content: '另一条只用来验证新增条目能被索引。',
      tag: '可信',
    })
    index.markDirty()
    assert.equal(index.search('新增条目').length, 1)
  } finally {
    index.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
