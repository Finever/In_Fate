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

test('记忆库 HTTP：树、文件 CRUD、回收站与 log 只读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-memory-library-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const app = buildBundle(configFor(dataRoot), new Container())
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' }
  const base = `${handle.url}/api/memory/library`
  try {
    const tree = await fetch(`${base}/tree`, { headers })
    assert.equal(tree.status, 200)
    const treeBody = await tree.json() as { tree: Array<{ path: string }> }
    assert.equal(treeBody.tree.some(node => node.path === 'detail'), true)

    const mkdir = await fetch(`${base}/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'detail/项目' }),
    })
    assert.equal(mkdir.status, 200)

    const document = {
      project: '项目',
      filename: '草稿',
      introduction: '测试',
      entries: [],
    }
    const write = await fetch(`${base}/file`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        path: 'detail/项目/草稿.json',
        text: `${JSON.stringify(document, null, 2)}\n`,
      }),
    })
    assert.equal(write.status, 200)
    const written = await write.json() as { file: { document?: { filename: string } } }
    assert.equal(written.file.document?.filename, '草稿')

    const move = await fetch(`${base}/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: 'detail/项目/草稿.json',
        to: 'detail/项目/成稿.json',
      }),
    })
    assert.equal(move.status, 200)

    const removed = await fetch(`${base}/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'detail/项目/成稿.json' }),
    })
    assert.equal(removed.status, 200)

    const trash = await fetch(`${base}/trash`, { headers })
    const trashBody = await trash.json() as { entries: Array<{ id: string }> }
    assert.equal(trashBody.entries.length, 1)

    const restored = await fetch(`${base}/restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: trashBody.entries[0]!.id }),
    })
    assert.equal(restored.status, 200)

    const read = await fetch(
      `${base}/file?${new URLSearchParams({ path: 'detail/项目/成稿.json' }).toString()}`,
      { headers },
    )
    assert.equal(read.status, 200)

    const log = await fetch(
      `${base}/file?${new URLSearchParams({ path: 'log/2026/01/01/x.jsonl' }).toString()}`,
      { headers },
    )
    assert.equal(log.status, 400)

    const commit = await fetch(`${handle.url}/api/memory/commit`, { headers })
    assert.equal(commit.status, 200)
    const commitBody = await commit.json() as { enabled: boolean; dirty: string[] }
    assert.equal(typeof commitBody.enabled, 'boolean')
    assert.equal(Array.isArray(commitBody.dirty), true)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
