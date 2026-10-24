import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { App } from '../src/app/bundle.ts'
import { startServer } from '../src/app/server.ts'

test('serve 托管 UI 静态文件，API 仍要 token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-ui-dist-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root">IF</div></body></html>\n',
    'utf8',
  )
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("if")\n', 'utf8')

  const app = {} as App
  const handle = await startServer(app, {
    port: 0,
    token: 'test-token',
    uiDir: dir,
  })
  try {
    const root = await fetch(`${handle.url}/`)
    assert.equal(root.status, 200)
    assert.match(await root.text(), /id="root"/)
    assert.match(root.headers.get('cache-control') ?? '', /no-cache/)

    const asset = await fetch(`${handle.url}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /javascript/)
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/)

    const spa = await fetch(`${handle.url}/sessions/some-id`)
    assert.equal(spa.status, 200)
    assert.match(await spa.text(), /id="root"/)

    const missing = await fetch(`${handle.url}/assets/missing.js`)
    assert.equal(missing.status, 404)

    const traversal = await fetch(`${handle.url}/%2e%2e%2fsecret.txt`)
    assert.equal(traversal.status, 403)

    const unauthorized = await fetch(`${handle.url}/api/health`)
    assert.equal(unauthorized.status, 401)

    const health = await fetch(`${handle.url}/api/health`, {
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('UI 未构建时给明确提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-ui-empty-'))
  const app = {} as App
  const handle = await startServer(app, {
    port: 0,
    token: 't',
    uiDir: dir,
  })
  try {
    const response = await fetch(`${handle.url}/`)
    assert.equal(response.status, 503)
    assert.match(await response.text(), /UI 未构建/)
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
