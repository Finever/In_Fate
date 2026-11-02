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

test('跨会话消息落目标收件箱并唤醒一轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-delivery-'))
  seedAgentModel(dir)
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('ack'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const config: AppConfig = {
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
    patch: { tools: { enabled: [] } },
  }

  const container = new Container()
  const app = buildBundle(config, container)
  try {
    const link = app.link({ from: 's1', to: 's2', relation: 'peer' })
    const delivery = app.sendMessage({
      from: 's1',
      to: 's2',
      text: '你卡在哪一步？',
      kind: 'question',
    })

    assert.equal(delivery.woke, true)
    assert.equal(delivery.linkId, link.linkId)

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const info = app.inspectSession('s2')
      if (info.state === 'idle' && info.events >= 3) break
      await sleep(25)
    }

    const info = app.inspectSession('s2')
    assert.equal(info.state, 'idle')
    assert.equal(info.pendingToolCalls.length, 0)

    const messages = app.history('s2')
    assert.ok(messages.some(message => message.role === 'system'
      && JSON.stringify(message).includes('你卡在哪一步')))
    assert.ok(messages.some(message => message.role === 'assistant'
      && JSON.stringify(message).includes('ack')))
    assert.ok(hits >= 1)
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
