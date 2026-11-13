import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { startServer } from '../src/app/server.ts'
import { EventStore } from '../src/core/store.ts'

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

    const custom = await fetch(`${handle.url}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'work-log-2026', createdBy: 'user', reason: 'custom' }),
    })
    assert.equal(custom.status, 200)
    const customBody = await custom.json() as { sessionId: string }
    assert.equal(customBody.sessionId, 'work-log-2026')

    const duplicate = await fetch(`${handle.url}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'work-log-2026' }),
    })
    assert.equal(duplicate.status, 400)

    const unsafe = await fetch(`${handle.url}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: '../escape' }),
    })
    assert.equal(unsafe.status, 400)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('GET /api/sessions 带出首条用户消息标题', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-title-'))
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const store = new EventStore(join(dir, 'sessions', 'session-title.jsonl'))
  store.append({
    stream: 'session:session-title',
    actor: 'system',
    type: 'session.created',
    payload: { sessionId: 'session-title', formatVersion: 2, createdBy: 'user' },
  })
  store.append({
    stream: 'session:session-title',
    actor: 'user',
    type: 'message.user',
    payload: { text: '列表里应该看到这句话' },
  })
  store.flush()

  const app = buildBundle(configFor(dir), new Container())
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  try {
    const listed = await fetch(`${handle.url}/api/sessions`, {
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(listed.status, 200)
    const data = await listed.json() as {
      sessions: Array<{ id: string; title?: string }>
    }
    const session = data.sessions.find(item => item.id === 'session-title')
    assert.ok(session)
    assert.equal(session.title, '列表里应该看到这句话')
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
