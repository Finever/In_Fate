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

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

test('按 agent 的工具白名单过滤 spec，并拒绝越权调用；审批覆盖生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tool-policy-'))
  let hits = 0
  let seenTools: string[] = []
  let dangerRan = false
  let blockedRan = false
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      hits += 1
      if (hits === 1) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tools?: Array<{ function?: { name?: string } }>
        }
        seenTools = (body.tools ?? []).map(tool => tool.function?.name ?? '')
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (hits === 1) {
        res.end(sse({
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-blocked',
                  function: { name: 'blocked', arguments: '{}' },
                },
                {
                  index: 1,
                  id: 'call-danger',
                  function: { name: 'danger', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        }))
        return
      }
      res.end(sse({
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    store.append({ stream: 'session:s', actor: 'system', type: 'session.created', payload: {} })
    const tools = new ToolRegistry()
    tools.register({
      name: 'blocked',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        blockedRan = true
        return { text: 'blocked ran' }
      },
    })
    tools.register({
      name: 'danger',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      meta: { dangerous: true },
      async run() {
        dangerRan = true
        return { text: 'danger ran' }
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
      toolAllow: ['danger'],
      toolApproval: { danger: 'auto' },
      now: () => new Date('2026-10-24T00:00:00.000Z'),
    })

    assert.equal(result.status, 'completed')
    assert.deepEqual(seenTools, ['danger'])
    assert.equal(dangerRan, true)
    assert.equal(blockedRan, false)
    const results = store.read().filter(event => event.type === 'tool.result')
    assert.equal(results.length, 2)
    const blocked = results.find(event => event.payload.callId === 'call-blocked')
    assert.match(String(blocked?.payload.text), /not allowed/)
    const danger = results.find(event => event.payload.callId === 'call-danger')
    assert.equal(danger?.payload.text, 'danger ran')
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
