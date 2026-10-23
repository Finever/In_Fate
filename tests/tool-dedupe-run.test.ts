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
      models: [{ id: 'test-model' }],
      apiKey: 'test-key',
    },
    model: { id: 'test-model' },
    endpoint: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` },
    apiModelId: 'test-model',
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

test('本轮已有结果的 toolCallId 不再执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tool-dedupe-'))
  let executions = 0
  let hits = 0

  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (hits === 1) {
      res.end(sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: { name: 'probe', arguments: '{}' },
            }],
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    store.append({ stream: 'session:s', actor: 'system', type: 'session.created', payload: {} })
    store.append({
      stream: 'session:s',
      actor: 'agent',
      type: 'tool.call',
      payload: { callId: 'call-1', call: 'probe', args: {} },
    })
    store.append({
      stream: 'session:s',
      actor: 'tool',
      type: 'tool.result',
      refs: { toolCall: 'call-1' },
      payload: { callId: 'call-1', text: 'previous', isError: false },
    })

    const tools = new ToolRegistry()
    tools.register({
      name: 'probe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        executions += 1
        return { text: 'executed' }
      },
    })

    const result = await runTurn('next', {
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
      maxSteps: 2,
      now: () => new Date('2026-10-23T00:00:00.000Z'),
    })

    assert.equal(result.steps, 2)
    assert.equal(executions, 0)
    assert.equal(store.read().filter(event => event.type === 'tool.result').length, 1)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
