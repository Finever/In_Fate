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
import { projectUiTimeline } from '../src/ui/timeline.ts'

const standard = (n: number) => ({ currency: 'CNY', perMillionTokens: n })

function resolvedFor(port: number): ResolvedModel {
  return {
    provider: {
      id: 'test',
      name: 'test',
      endpoints: { openai: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` } },
      models: [{ id: 'm' }],
      apiKey: 'test',
    },
    model: {
      id: 'm',
      pricing: {
        input: standard(1),
        output: standard(8),
        cacheRead: standard(0.1),
      },
    },
    endpoint: { adapterFamily: 'openai', baseUrl: `http://127.0.0.1:${port}` },
    apiModelId: 'm',
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

test('turn.completed 记录模型、耗时、用量与成本（缓存不重复计费）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-run-metrics-'))
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
              function: { name: 'noop', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }))
      return
    }
    res.end(sse({
      choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 2_000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 1_600 },
      },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    store.append({ stream: 'session:s', actor: 'system', type: 'session.created', payload: {} })
    const tools = new ToolRegistry()
    tools.register({
      name: 'noop',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        await new Promise(resolve => setTimeout(resolve, 30))
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
    assert.equal(result.usage.input, 3_000)
    assert.equal(result.usage.output, 510)
    assert.equal(result.usage.cacheRead, 2_400)
    assert.deepEqual(result.model, { provider: 'test', model: 'm' })
    assert.ok((result.durationMs ?? 0) > 0)
    assert.ok((result.modelDurationMs ?? 0) > 0)
    assert.ok((result.toolDurationMs ?? 0) >= 25)
    assert.equal(result.cost?.priced, true)
    assert.ok(Math.abs((result.cost?.total ?? 0) - 0.00492) < 1e-9)

    const completed = store.read().filter(event => event.type === 'turn.completed').at(-1)
    assert.deepEqual(completed?.payload.model, { provider: 'test', model: 'm' })
    assert.equal(completed?.payload.modelDurationMs, result.modelDurationMs)
    assert.equal(completed?.payload.toolDurationMs, result.toolDurationMs)
    assert.deepEqual(completed?.payload.cost, result.cost)

    const page = projectUiTimeline('s', store.read(), { limit: 5 })
    const turn = page.items.find(item => item.kind === 'turn')
    assert.equal(turn?.turnUsage?.modelDurationMs, result.modelDurationMs)
    assert.equal(turn?.turnUsage?.toolDurationMs, result.toolDurationMs)
    assert.equal(turn?.turnUsage?.cost?.total, result.cost?.total)
    assert.equal(turn?.turnUsage?.cost?.period, 'standard')
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
