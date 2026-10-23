import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { chatOpenAI } from '../src/model/openai.ts'
import type { ResolvedModel } from '../src/model/registry.ts'
import { ModelTimeoutError } from '../src/model/retry.ts'

function resolvedFor(port: number): ResolvedModel {
  return {
    provider: {
      id: 'test',
      name: 'test',
      endpoints: {
        openai: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` },
      },
      models: [{ id: 'test-model' }],
      apiKey: 'test-key',
    },
    model: { id: 'test-model' },
    endpoint: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` },
    apiModelId: 'test-model',
  }
}

function sse(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{
  server: Server
  port: number
}> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

test('500 后重试并拿到完整文本', async () => {
  let hits = 0
  const { server, port } = await listen((_req, res) => {
    hits += 1
    if (hits === 1) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('temporary')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('ok'))
  })

  try {
    const text: string[] = []
    let retried: { status?: number; attempt: number } | undefined
    for await (const event of chatOpenAI({
      resolved: resolvedFor(port),
      system: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 2,
        timeoutMs: 2_000,
        sleep: async () => {},
        random: () => 0.5,
      },
      onRetry: info => { retried = info },
    })) {
      if (event.type === 'text') text.push(event.text)
    }

    assert.equal(hits, 2)
    assert.equal(text.join(''), 'ok')
    assert.equal(retried?.status, 500)
    assert.equal(retried?.attempt, 1)
  } finally {
    await close(server)
  }
})

test('超时抛出 ModelTimeoutError', async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // 只发注释，不产出任何 ModelEvent，保持连接不结束。
    res.write(': keep-alive\n\n')
  })

  try {
    await assert.rejects(
      (async () => {
        for await (const _event of chatOpenAI({
          resolved: resolvedFor(port),
          system: 'test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          retry: { maxAttempts: 1, timeoutMs: 80 },
        })) {
          // 不应产出事件
        }
      })(),
      (error: unknown) => error instanceof ModelTimeoutError,
    )
  } finally {
    await close(server)
  }
})

test('已经吐出内容后断流不重试', async () => {
  let hits = 0
  const { server, port } = await listen((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: 'partial' }, finish_reason: null }],
    })}\n\n`, () => {
      setTimeout(() => res.destroy(), 20)
    })
  })

  try {
    const text: string[] = []
    await assert.rejects(async () => {
      for await (const event of chatOpenAI({
        resolved: resolvedFor(port),
        system: 'test',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        retry: {
          maxAttempts: 3,
          baseDelayMs: 1,
          timeoutMs: 2_000,
          sleep: async () => {},
        },
      })) {
        if (event.type === 'text') text.push(event.text)
      }
    })

    assert.equal(hits, 1)
    assert.equal(text.join(''), 'partial')
  } finally {
    await close(server)
  }
})
