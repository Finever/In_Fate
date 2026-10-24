import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { runTurn } from '../src/loop/run.ts'
import type { ResolvedModel } from '../src/model/registry.ts'
import { InMemoryApprovalRegistry } from '../src/tools/approval.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

function resolvedFor(port: number): ResolvedModel {
  return {
    provider: {
      id: 'test',
      name: 'test',
      endpoints: { openai: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` } },
      models: [{ id: 'm' }],
      apiKey: 'test',
    },
    model: { id: 'm' },
    endpoint: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` },
    apiModelId: 'm',
  }
}

test('工具正文执行前，tool.call 已经落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-checkpoint-'))
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (hits === 1) {
      res.end(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-check',
              function: { name: 'check_tool', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })}\n\ndata: [DONE]\n\n`)
    } else {
      res.end(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    store.append({ stream: 'session:s', actor: 'system', type: 'session.created', payload: {} })
    const tools = new ToolRegistry()
    let observed = false
    tools.register({
      name: 'check_tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        observed = store.read().some(event =>
          event.type === 'tool.call' && event.payload.callId === 'call-check')
        return { text: 'ok' }
      },
    })

    const result = await runTurn('go', {
      store,
      sessionId: 's',
      profile: {
        dataRoot: dir,
        timeZone: 'Asia/Shanghai',
        principals: { user: { id: 'user' }, agents: [{ id: 'agent' }] },
      },
      model: resolvedFor(port),
      tools,
      approvals: new InMemoryApprovalRegistry(),
      sections: [],
      maxSteps: 5,
      now: () => new Date('2026-10-24T00:00:00.000Z'),
    })

    assert.equal(result.status, 'completed')
    assert.equal(observed, true)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('工具 waiting 会结束本轮并落 waiting 状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-waiting-'))
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-1',
            function: { name: 'wait_tool', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    store.append({ stream: 'session:s', actor: 'system', type: 'session.created', payload: {} })
    const tools = new ToolRegistry()
    tools.register({
      name: 'wait_tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return { text: 'waiting', waiting: true }
      },
    })

    const result = await runTurn('go', {
      store,
      sessionId: 's',
      profile: {
        dataRoot: dir,
        timeZone: 'Asia/Shanghai',
        principals: { user: { id: 'user' }, agents: [{ id: 'agent' }] },
      },
      model: resolvedFor(port),
      tools,
      approvals: new InMemoryApprovalRegistry(),
      sections: [],
      maxSteps: 5,
      now: () => new Date('2026-10-24T00:00:00.000Z'),
    })

    assert.equal(result.status, 'waiting')
    assert.equal(result.steps, 1)
    assert.equal(hits, 1)
    const completed = store.read().filter(event => event.type === 'turn.completed').at(-1)
    assert.equal(completed?.payload.status, 'waiting')
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
