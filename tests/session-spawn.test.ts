import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AppConfig } from '../src/app/config.ts'
import { buildBundle } from '../src/app/bundle.ts'
import { Container } from '../src/app/container.ts'
import { seedAgentModel } from './support.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function sse(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`
}

function configFor(dir: string, port: number, maxPerCreator = 16): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot: dir,
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
          baseUrl: `http://127.0.0.1:${port}`,
        },
      },
      models: [{ id: 'm' }],
      apiKey: 'test',
    }],
    presets: [],
    defaultModel: { provider: 'fake', model: 'm' },
    patch: {
      tools: { enabled: [] },
      runtime: { sessions: { maxPerCreator } },
    },
  }
}

test('agent 创建用户会话，自动连接并跑第一条任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-spawn-'))
  seedAgentModel(dir)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('spawned ack'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const app = buildBundle(configFor(dir, port), new Container())
  try {
    const spawned = app.spawnSession({
      creator: 'main',
      text: '做一件小事',
      reason: '测试分工',
    })
    assert.ok(spawned.sessionId.startsWith('session-'))
    assert.ok(spawned.linkId.startsWith('link-'))

    const info = app.sessions().find(session => session.id === spawned.sessionId)
    assert.equal(info?.createdBy, 'agent')
    assert.equal(info?.kind, 'agent')
    assert.deepEqual(info?.createdFrom, { sessionId: 'main' })
    assert.equal(app.links(spawned.sessionId).length, 1)

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if (app.inspectSession(spawned.sessionId).state === 'idle') break
      await sleep(25)
    }
    assert.equal(app.inspectSession(spawned.sessionId).state, 'idle')
    assert.ok(app.history(spawned.sessionId).some(message =>
      JSON.stringify(message).includes('spawned ack')))
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('agent 创建会话受配额限制', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-spawn-quota-'))
  seedAgentModel(dir)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('ack'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const app = buildBundle(configFor(dir, port, 1), new Container())
  try {
    const first = app.spawnSession({ creator: 'main', text: 'one' })
    assert.ok(first.sessionId)
    assert.throws(
      () => app.spawnSession({ creator: 'main', text: 'two' }),
      /quota exceeded/,
    )
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
