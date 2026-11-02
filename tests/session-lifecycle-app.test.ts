import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AppConfig } from '../src/app/config.ts'
import { buildBundle } from '../src/app/bundle.ts'
import { Container } from '../src/app/container.ts'
import { EventStore } from '../src/core/store.ts'
import { seedAgentModel } from './support.ts'

function sse(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`
}

function configFor(dataRoot: string, port: number): AppConfig {
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
          baseUrl: `http://127.0.0.1:${port}`,
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

function seedSession(dir: string, id: string): void {
  const store = new EventStore(join(dir, 'sessions', `${id}.jsonl`))
  store.append({
    stream: `session:${id}`,
    actor: 'system',
    type: 'session.created',
    payload: {
      sessionId: id,
      formatVersion: 2,
      createdAt: '2026-10-24T04:00:00.000Z',
      createdBy: 'user',
    },
  })
  store.flush()
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function listen(
  handler: Handler,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

test('生命周期：归档隐藏、恢复显示、删除关闭连接并拒绝写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-lifecycle-app-'))
  seedAgentModel(dir)
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('ok'))
  })
  seedSession(dir, 's1')
  seedSession(dir, 's2')

  const app = buildBundle(configFor(dir, port), new Container())
  try {
    assert.deepEqual(app.sessions().map(item => item.id).sort(), ['s1', 's2'])
    app.link({ from: 's1', to: 's2', relation: 'peer' })

    const archived = app.archiveSession('s2', { reason: '做完了' })
    assert.equal(archived.state, 'archived')
    assert.equal(app.sessionState('s2'), 'archived')
    assert.deepEqual(app.sessions().map(item => item.id), ['s1'])
    assert.equal(
      app.sessions({ includeArchived: true }).find(item => item.id === 's2')?.lifecycle,
      'archived',
    )
    assert.throws(
      () => app.sendMessage({ from: 's1', to: 's2', text: '还在吗', kind: 'question' }),
      /not active/,
    )
    assert.throws(() => app.join({ sessionId: 's1', targets: ['s2'] }), /not active/)

    app.unarchiveSession('s2')
    assert.equal(app.sessionState('s2'), 'active')

    app.deleteSession('s2', { reason: '不再需要' })
    assert.equal(app.sessionState('s2'), 'deleted')
    assert.deepEqual(app.sessions().map(item => item.id), ['s1'])
    assert.equal(
      app.sessions({ includeDeleted: true }).find(item => item.id === 's2')?.lifecycle,
      'deleted',
    )
    assert.equal(app.links('s2', { includeClosed: false }).length, 0)
    assert.equal(app.links('s2', { includeClosed: true }).length, 1)
    assert.throws(
      () => app.sendMessage({ from: 's1', to: 's2', text: '喂', kind: 'note' }),
      /not active/,
    )
    await assert.rejects(app.chat({ sessionId: 's2', text: 'go' }), /deleted|not active/)
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('生命周期：正在跑的会话默认拒绝归档/删除，force 只挡后续唤醒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-lifecycle-running-'))
  seedAgentModel(dir)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { server, port } = await listen(async (_req, res) => {
    await gate
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('late ok'))
  })
  seedSession(dir, 's1')

  const app = buildBundle(configFor(dir, port), new Container())
  try {
    const turn = app.chat({ sessionId: 's1', text: 'go' })
    assert.throws(() => app.deleteSession('s1'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ESESSIONBUSY')
      return true
    })
    assert.throws(() => app.archiveSession('s1'), /running/)

    const deleted = app.deleteSession('s1', { force: true, reason: '强制下线' })
    assert.equal(deleted.state, 'deleted')
    assert.equal(app.sessionState('s1'), 'deleted')

    release()
    const result = await turn
    assert.equal(result.status, 'completed')
    assert.equal(app.sessionState('s1'), 'deleted')
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
