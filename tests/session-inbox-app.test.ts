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
import { SessionWriter } from '../src/core/session-writer.ts'
import { EventStore } from '../src/core/store.ts'
import { sessionFile } from '../src/app/session.ts'
import { sessionStream } from '../src/core/streams.ts'
import { seedAgentModel } from './support.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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

/** 直接写一条“消息到了、但没有任何轮看过”的会话日志，模拟崩溃现场。 */
function seedPendingMessage(
  dataRoot: string,
  sessionId: string,
  options: { seen?: boolean } = {},
): void {
  const store = new EventStore(sessionFile(dataRoot, sessionId))
  const writer = SessionWriter.open(store)
  try {
    writer.append({
      stream: sessionStream(sessionId),
      actor: 'system',
      type: 'session.created',
      payload: {
        sessionId,
        createdAt: '2026-10-24T04:00:00.000Z',
        formatVersion: 2,
        seqBase: 0,
        createdBy: 'user',
      },
    })
    writer.append({
      stream: sessionStream(sessionId),
      actor: 'system',
      type: 'session.message',
      refs: { fromSession: 'other', link: 'link-test' },
      payload: {
        messageId: 'msg-recover-1',
        fromSession: 'other',
        linkId: 'link-test',
        kind: 'question',
        text: '崩溃前没处理的任务',
        wake: true,
      },
    })
    if (options.seen) {
      writer.append({
        stream: sessionStream(sessionId),
        actor: 'system',
        type: 'turn.completed',
        payload: { steps: 0, usage: {}, aborted: false, hitLimit: false, status: 'completed', lastSeenSeq: 1 },
      })
    }
    writer.flush()
  } finally {
    writer.close()
  }
}

test('启动恢复：崩溃前未处理的 wake 消息会补跑一轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-inbox-recover-'))
  seedAgentModel(dir)
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('recovered ack'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  seedPendingMessage(dir, 'session-recover-1')

  const app = buildBundle(configFor(dir, port), new Container())
  try {
    assert.equal(app.recoverInboxes(), 1)

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if (app.inspectSession('session-recover-1').state === 'idle') break
      await sleep(25)
    }
    assert.equal(app.inspectSession('session-recover-1').state, 'idle')
    assert.ok(app.history('session-recover-1').some(message =>
      JSON.stringify(message).includes('recovered ack')))
    assert.ok(hits >= 1)
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('启动恢复：已经进过完成轮的消息不重复跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-inbox-seen-'))
  seedAgentModel(dir)
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('should not run'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  seedPendingMessage(dir, 'session-recover-2', { seen: true })

  const app = buildBundle(configFor(dir, port), new Container())
  try {
    assert.equal(app.recoverInboxes(), 0)
    await sleep(150)
    assert.equal(hits, 0)
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
