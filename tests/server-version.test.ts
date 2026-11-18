import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from '../src/app/bundle.ts'
import { startServer } from '../src/app/server.ts'
import { IF_NAME, IF_VERSION } from '../src/version.ts'

test('HTTP 版本接口与 VERSION 一致', async () => {
  const app = {} as App
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  try {
    const response = await fetch(`${handle.url}/api/version`, {
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      name: IF_NAME,
      version: IF_VERSION,
    })
  } finally {
    await handle.close()
  }
})
