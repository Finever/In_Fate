import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { SemanticMemoryIndex, type MemoryEmbedder } from '../src/memory/semantic-index.ts'
import { MemoryStore } from '../src/memory/store.ts'

const fakeEmbedder: MemoryEmbedder = {
  isAvailable: () => true,
  modelId: () => 'fake-v1',
  async embedQuery(text) {
    return embed(text)
  },
  async embedDocuments(texts) {
    return texts.map(embed)
  },
}

function embed(text: string): Float32Array {
  if (text.includes('深夜')) return new Float32Array([1, 0])
  if (text.includes('面条')) return new Float32Array([0, 1])
  return new Float32Array([0.5, 0.5])
}

test('语义索引：向量召回、标脏重建、状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-semantic-'))
  const root = join(dir, 'memory')
  ensureMemoryLayout(root)
  const store = new MemoryStore(root)
  const index = new SemanticMemoryIndex(root, store, fakeEmbedder)
  try {
    await store.add('detail:环境/测试', {
      content: '触久喜欢在深夜写代码',
      tag: '确信',
      introduction: '测试',
    })
    index.markDirty()
    const built = index.build()
    await built
    assert.equal(index.status().ready, true)
    assert.equal(index.status().entries, 1)

    const hits = await index.search('深夜')
    assert.equal(hits[0]?.id, '测试-0001')

    await store.add('detail:环境/测试', {
      content: '今天晚饭吃的是面条',
      tag: '可信',
    })
    index.markDirty()
    assert.equal(index.status().ready, false)
    await index.build()
    assert.equal(index.status().entries, 2)
    const more = await index.search('面条', { limit: 1 })
    assert.equal(more[0]?.preview.includes('面条'), true)
  } finally {
    index.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
