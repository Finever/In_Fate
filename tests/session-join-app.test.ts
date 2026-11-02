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

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

function configFor(dir: string, port: number): AppConfig {
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
    patch: { tools: { enabled: [] } },
  }
}

test('join 等待目标完成后唤醒，不占模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-join-app-'))
  seedAgentModel(dir)
  let joinCalls = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: { role?: string; content?: unknown }[]
      }
      const texts = (body.messages ?? [])
        .map(message => typeof message.content === 'string' ? message.content : '')
      const hasJoinNotice = texts.some(text => text.includes('[join]'))
      const hasWait = texts.some(text => text.includes('wait'))
      const hasWork = texts.some(text => text.includes('work'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })

      if (!hasJoinNotice && hasWait) {
        joinCalls += 1
        res.end(sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call-join',
                function: {
                  name: 'session_join',
                  arguments: JSON.stringify({ targets: ['a'], mode: 'all' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }))
        return
      }

      const text = hasWork ? 'work done' : 'joined'
      setTimeout(() => {
        res.end(sse({
          choices: [{ delta: { content: text }, finish_reason: 'stop' }],
        }))
      }, hasWork ? 120 : 0)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const container = new Container()
  const app = buildBundle(configFor(dir, port), container)
  try {
    app.link({ from: 'w', to: 'a', relation: 'peer' })

    const target = app.chat({ sessionId: 'a', text: 'work' })
    await sleep(20)
    const waiting = app.chat({ sessionId: 'w', text: 'wait' })

    const waitingResult = await waiting
    assert.equal(waitingResult.status, 'waiting')
    assert.equal(joinCalls, 1)

    await target
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if (app.inspectSession('w').state === 'idle') break
      await sleep(25)
    }

    assert.equal(app.inspectSession('w').state, 'idle')
    assert.deepEqual(app.pendingJoins('w'), [])
    const messages = app.history('w')
    assert.ok(messages.some(message => JSON.stringify(message).includes('joined')))
  } finally {
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
