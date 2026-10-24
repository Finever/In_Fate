import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [{
      id: 'fake',
      name: 'fake',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai',
          baseUrl: 'http://127.0.0.1:1',
        },
      },
      models: [{ id: 'm' }],
      apiKey: 'test',
    }],
    presets: [],
    defaultModel: { provider: 'fake', model: 'm' },
    patch: { tools: { enabled: [] } },
  }
}

test('POST /api/sessions 直接落 session.created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-sessions-'))
  const app = buildBundle(configFor(dir), new Container())
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  try {
    const created = await fetch(`${handle.url}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ createdBy: 'user', reason: 'ui-test' }),
    })
    assert.equal(created.status, 200)
    const body = await created.json() as { sessionId: string }
    assert.match(body.sessionId, /^session-/)

    const listed = await fetch(`${handle.url}/api/sessions`, {
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(listed.status, 200)
    const data = await listed.json() as {
      sessions: Array<{ id: string; createdBy?: string; lifecycle: string; reason?: string }>
    }
    const session = data.sessions.find(item => item.id === body.sessionId)
    assert.ok(session)
    assert.equal(session.lifecycle, 'active')
    assert.equal(session.createdBy, 'user')
    assert.equal(session.reason, 'ui-test')
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
