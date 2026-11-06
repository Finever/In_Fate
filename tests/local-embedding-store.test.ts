import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EmbeddingInstallJobs } from '../src/model/local/embedding-jobs.ts'
import type { EmbeddingModelPreset } from '../src/model/local/embedding-models.ts'
import { LocalEmbeddingStore } from '../src/model/local/embedding-store.ts'

function tinyPreset(data: Buffer, sha = createHash('sha256').update(data).digest('hex')): EmbeddingModelPreset {
  return {
    id: 'tiny-embed',
    name: 'Tiny',
    description: 'test',
    repo: 'test/tiny',
    file: 'tiny.gguf',
    size: data.byteLength,
    sha256: sha,
    dimensions: 4,
    contextSize: 512,
    license: 'MIT',
    quantization: 'Q8_0',
    queryPrefix: 'query: ',
  }
}

test('本地 embedding 模型：下载校验、激活、删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-embedding-store-'))
  const data = Buffer.from('tiny embedding weights')
  const preset = tinyPreset(data)
  const progress: number[] = []
  const store = new LocalEmbeddingStore(join(dir, 'models'), {
    presets: [preset],
    fetchImpl: async () => new Response(data, {
      status: 200,
      headers: { 'content-length': String(data.byteLength) },
    }),
  })
  try {
    const manifest = await store.install('tiny-embed', {
      onProgress: value => progress.push(value.received),
    })
    assert.equal(manifest.sha256, preset.sha256)
    assert.equal(readFileSync(manifest.path).toString('utf8'), data.toString('utf8'))
    assert.equal(store.status('tiny-embed').installed, true)
    assert.equal(store.status('tiny-embed').active, false)
    assert.ok(progress.length > 0)

    store.activate('tiny-embed')
    assert.equal(store.status('tiny-embed').active, true)
    assert.equal(store.active()?.id, 'tiny-embed')

    store.remove('tiny-embed')
    assert.equal(store.status('tiny-embed').installed, false)
    assert.equal(store.active(), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('本地 embedding 模型：sha256 不匹配不落正式文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-embedding-bad-'))
  const data = Buffer.from('bad weights')
  const preset = tinyPreset(data, '0'.repeat(64))
  const store = new LocalEmbeddingStore(join(dir, 'models'), {
    presets: [preset],
    fetchImpl: async () => new Response(data, {
      status: 200,
      headers: { 'content-length': String(data.byteLength) },
    }),
  })
  try {
    await assert.rejects(() => store.install('tiny-embed'), /sha256 mismatch/)
    assert.equal(store.status('tiny-embed').installed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('安装任务：完成后状态为 done，并自动激活第一个模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-embedding-job-'))
  const data = Buffer.from('job weights')
  const preset = tinyPreset(data)
  const store = new LocalEmbeddingStore(join(dir, 'models'), {
    presets: [preset],
    fetchImpl: async () => new Response(data, {
      status: 200,
      headers: { 'content-length': String(data.byteLength) },
    }),
  })
  const jobs = new EmbeddingInstallJobs(store)
  try {
    const started = jobs.start('tiny-embed')
    assert.equal(started.status, 'running')
    const done = await jobs.wait(started.id)
    assert.equal(done?.status, 'done')
    assert.equal(done?.ratio, 1)
    assert.equal(store.status('tiny-embed').active, true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
