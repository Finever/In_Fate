import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { startServer } from '../src/app/server.ts'

function configFor(dataRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' } },
    },
    providers: [],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
}

test('本地模型 HTTP：列出两个预设，未安装不可激活', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-local-models-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const app = buildBundle(configFor(dataRoot), new Container())
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' }
  try {
    const list = await fetch(`${handle.url}/api/local-models/embeddings`, { headers })
    assert.equal(list.status, 200)
    const body = await list.json() as {
      models: Array<{ preset: { id: string }; installed: boolean; active: boolean }>
    }
    assert.deepEqual(body.models.map(model => model.preset.id), [
      'bge-base-zh-v1.5',
      'qwen3-embedding-0.6b',
    ])
    assert.equal(body.models.every(model => !model.installed && !model.active), true)

    const activate = await fetch(
      `${handle.url}/api/local-models/embeddings/bge-base-zh-v1.5/activate`,
      { method: 'POST', headers },
    )
    assert.equal(activate.status, 400)

    const job = await fetch(`${handle.url}/api/local-models/jobs/nope`, { headers })
    assert.equal(job.status, 404)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
