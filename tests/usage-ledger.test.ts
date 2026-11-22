import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { Event } from '../src/core/events.ts'
import { resolveApiKeyEntries } from '../src/model/registry.ts'
import type { ProviderConfig } from '../src/model/types.ts'
import { backfillUsage } from '../src/usage/backfill.ts'
import { UsageLedger } from '../src/usage/ledger.ts'

function event(partial: Partial<Event> & Pick<Event, 'type' | 'payload'>): Event {
  return {
    v: 1,
    id: partial.id ?? 'evt-1',
    ts: partial.ts ?? '2026-11-22T10:00:00.000Z',
    stream: partial.stream ?? 'session:s1',
    actor: partial.actor ?? 'system',
    ...partial,
  }
}

test('usage.recorded 写账本并带 key 快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-usage-ledger-'))
  const ledger = UsageLedger.open(join(dir, 'usage.sqlite'))
  try {
    ledger.recordEvent(event({
      id: 'u1',
      type: 'usage.recorded',
      payload: {
        requestId: 'req-1',
        turn: 1,
        step: 1,
        provider: 'p1',
        model: 'm1',
        agentId: 'main',
        source: 'user',
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
        cost: {
          currency: 'CNY',
          input: 0.1,
          output: 0.2,
          cacheRead: 0.01,
          cacheWrite: 0.02,
          total: 0.33,
          priced: true,
          period: 'standard',
        },
        durationMs: 1200,
        firstTokenMs: 300,
        status: 'completed',
        attempts: 1,
        key: { id: 'k1', label: '主力', masked: 'sk-1…cdef', source: 'config' },
        priority: 'interactive',
        requestedAt: '2026-11-22T10:00:00.000Z',
      },
    }))
    assert.deepEqual(ledger.stats(), {
      requests: 1,
      turns: 0,
      tools: 0,
      legacy: 0,
      schemaVersion: 4,
      backfillDone: false,
      rollupRows: 0,
      detailSince: '2026-11-22T10:00:00.000Z',
    })

    const db = new DatabaseSync(ledger.file)
    try {
      const row = db.prepare(`
        SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
               cost_total, cost_currency, api_key_id, api_key_label, api_key_masked
        FROM usage_request WHERE id = 'u1'
      `).get() as Record<string, unknown>
      assert.equal(row.input_tokens, 10)
      assert.equal(row.output_tokens, 5)
      assert.equal(row.cache_read_tokens, 2)
      assert.equal(row.cache_write_tokens, 1)
      assert.equal(row.cost_total, 0.33)
      assert.equal(row.cost_currency, 'CNY')
      assert.equal(row.api_key_id, 'k1')
      assert.equal(row.api_key_label, '主力')
      assert.equal(row.api_key_masked, 'sk-1…cdef')
    } finally {
      db.close()
    }
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('重复回放同一条事件不会重复计数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-usage-idempotent-'))
  const ledger = UsageLedger.open(join(dir, 'usage.sqlite'))
  try {
    const recorded = event({
      id: 'u1',
      type: 'usage.recorded',
      payload: {
        requestId: 'req-1',
        turn: 1,
        provider: 'p1',
        model: 'm1',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        cost: { total: 0, priced: false, period: 'standard' },
        status: 'completed',
      },
    })
    ledger.recordEvent(recorded)
    ledger.recordEvent(recorded)
    assert.equal(ledger.stats().requests, 1)
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('旧 turn.completed 没有 usage.recorded 时按 legacy 聚合入库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-usage-legacy-'))
  const ledger = UsageLedger.open(join(dir, 'usage.sqlite'))
  try {
    ledger.recordEvent(event({
      id: 't1',
      type: 'turn.completed',
      payload: {
        steps: 3,
        turn: 1,
        agentId: 'main',
        source: 'user',
        usage: { input: 30, output: 12, cacheRead: 4, cacheWrite: 0 },
        cost: {
          currency: 'CNY',
          input: 0.3,
          output: 0.4,
          cacheRead: 0.01,
          cacheWrite: 0,
          total: 0.71,
          priced: true,
          period: 'standard',
        },
        status: 'completed',
        model: { provider: 'p1', model: 'm1' },
        durationMs: 5000,
        modelDurationMs: 4000,
        toolDurationMs: 1000,
      },
    }))
    const stats = ledger.stats()
    assert.equal(stats.requests, 1)
    assert.equal(stats.turns, 1)
    assert.equal(stats.legacy, 1)

    const db = new DatabaseSync(ledger.file)
    try {
      const row = db.prepare(
        'SELECT record_kind, request_count FROM usage_request WHERE id = ?',
      ).get('legacy:t1') as { record_kind: string; request_count: number }
      assert.equal(row.record_kind, 'legacy-aggregate')
      assert.equal(row.request_count, 3)
    } finally {
      db.close()
    }
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('从历史会话 JSONL 回填，二次调用跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-usage-backfill-'))
  const dataRoot = join(dir, 'data')
  const sessions = join(dataRoot, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const events = [
    {
      v: 1,
      id: 'c1',
      ts: '2026-11-20T10:00:00.000Z',
      stream: 'session:s1',
      actor: 'user',
      type: 'session.created',
      payload: { kind: 'user', createdBy: 'user' },
    },
    {
      v: 1,
      id: 't1',
      ts: '2026-11-20T10:01:00.000Z',
      stream: 'session:s1',
      actor: 'system',
      type: 'turn.completed',
      payload: {
        steps: 2,
        usage: { input: 10, output: 5, cacheRead: 1 },
        status: 'completed',
        model: { provider: 'p1', model: 'm1' },
        durationMs: 1000,
      },
    },
  ]
  writeFileSync(
    join(sessions, 's1.jsonl'),
    `${events.map(item => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )

  const ledger = UsageLedger.open(join(dataRoot, 'usage', 'usage.sqlite'))
  try {
    const first = await backfillUsage(dataRoot, ledger)
    assert.equal(first.skipped, false)
    assert.equal(first.turns, 1)
    assert.equal(ledger.stats().legacy, 1)
    assert.equal(ledger.meta('backfill_done'), '1')

    const second = await backfillUsage(dataRoot, ledger)
    assert.equal(second.skipped, true)
    assert.equal(ledger.stats().legacy, 1)
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('查询层：总览 / 时间线 / 分组 / 明细分页', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-usage-query-'))
  const ledger = UsageLedger.open(join(dir, 'usage.sqlite'))
  const record = (
    id: string,
    at: string,
    agentId: string,
    model: { provider: string; model: string },
    usage: Record<string, number>,
    extra: Record<string, unknown> = {},
  ): void => {
    ledger.recordEvent(event({
      id,
      ts: at,
      type: 'usage.recorded',
      payload: {
        requestId: `req-${id}`,
        turn: 1,
        agentId,
        source: 'user',
        ...model,
        usage,
        cost: { total: 0, priced: false, period: 'standard' },
        status: 'completed',
        requestedAt: at,
        ...extra,
      },
    }))
  }
  try {
    record('u1', '2026-11-20T10:00:00.000Z', 'main', { provider: 'p1', model: 'm1' },
      { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 }, {
        cost: {
          currency: 'CNY', input: 0.1, output: 0.2, cacheRead: 0.01,
          cacheWrite: 0, total: 0.33, priced: true, period: 'standard',
        },
        durationMs: 1200,
        firstTokenMs: 300,
      })
    record('u2', '2026-11-21T09:00:00.000Z', 'main', { provider: 'p1', model: 'm1' },
      { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 }, {
        cost: {
          currency: 'CNY', input: 0.2, output: 0.3, cacheRead: 0,
          cacheWrite: 0, total: 0.5, priced: true, period: 'standard',
        },
        durationMs: 2000,
      })
    record('u3', '2026-11-21T11:00:00.000Z', 'helper', { provider: 'p2', model: 'm2' },
      { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }, { status: 'failed' })
    ledger.recordTool({
      sessionId: 's1',
      turn: 1,
      agentId: 'main',
      toolName: 'read_file',
      calls: 3,
      ok: 2,
      errors: 1,
      durationMs: 500,
      argsBytes: 10,
      resultBytes: 20,
      updatedAt: '2026-11-21T11:05:00.000Z',
    })

    const overview = ledger.overview({}, { timeZone: 'utc' })
    assert.equal(overview.requests, 3)
    assert.equal(overview.tokens.input, 35)
    assert.equal(overview.tokens.output, 17)
    assert.equal(overview.tokens.total, 52)
    assert.equal(overview.tokens.cacheRead, 2)
    assert.ok(Math.abs(overview.costTotal - 0.83) < 1e-9)
    assert.equal(overview.costByCurrency.length, 1)
    assert.equal(overview.costByCurrency[0]?.currency, 'CNY')
    assert.ok(Math.abs((overview.costByCurrency[0]?.total ?? 0) - 0.83) < 1e-9)
    assert.equal(overview.unpricedRequests, 1)
    assert.equal(overview.failedRequests, 1)
    assert.equal(overview.activeDays, 2)
    assert.equal(overview.longestStreak, 2)
    assert.deepEqual(overview.peakDay, { date: '2026-11-21', tokens: 37 })
    assert.equal(overview.topModel?.modelId, 'm1')
    assert.equal(overview.topModel?.tokens, 45)
    assert.equal(overview.avgFirstTokenMs, 300)
    assert.equal(overview.avgDurationMs, 1600)
    assert.equal(overview.tps, 15 / 3.2)
    assert.equal(overview.dailyAverage.tokens, 26)
    assert.ok(Math.abs(overview.cacheHitRate - 2 / 37) < 1e-9)

    assert.equal(ledger.overview({ agentId: 'helper' }).requests, 1)
    assert.equal(ledger.overview({ agentId: 'helper' }).failedRequests, 1)
    assert.equal(
      ledger.overview({ from: '2026-11-21', to: '2026-11-21' }, { timeZone: 'utc' }).requests,
      2,
    )

    const timeline = ledger.timeline({}, { bucket: 'day', timeZone: 'utc' })
    assert.deepEqual(
      timeline.map(point => [point.bucket, point.requests, point.tokens.total, point.currency]),
      [
        ['2026-11-20', 1, 15, 'CNY'],
        ['2026-11-21', 1, 7, undefined],
        ['2026-11-21', 1, 30, 'CNY'],
      ],
    )

    const models = ledger.groups({}, { groupBy: 'model' })
    assert.equal(models.length, 2)
    assert.equal(models[0]?.modelId, 'm1')
    assert.equal(models[0]?.requestCount, 2)
    assert.equal(models[0]?.tokens.total, 45)
    assert.ok(Math.abs((models[0]?.cost ?? 0) - 0.83) < 1e-9)
    assert.equal(models[0]?.currency, 'CNY')
    assert.equal(models[1]?.modelId, 'm2')
    assert.equal(models[1]?.currency, undefined)

    const agents = ledger.groups({}, { groupBy: 'agent' })
    assert.deepEqual(
      agents.map(row => [row.agentId, row.requestCount]),
      [['main', 2], ['helper', 1]],
    )

    const tools = ledger.groups({}, { groupBy: 'tool' })
    assert.equal(tools.length, 1)
    assert.equal(tools[0]?.label, 'read_file')
    assert.equal(tools[0]?.requestCount, 3)
    assert.equal(tools[0]?.toolErrors, 1)
    assert.equal(tools[0]?.toolDurationMs, 500)

    const page = ledger.requests({}, { limit: 2 })
    assert.equal(page.total, 3)
    assert.equal(page.rows.length, 2)
    assert.equal(page.rows[0]?.id, 'u3')
    assert.equal(page.rows[0]?.status, 'failed')
    assert.equal(page.rows[1]?.id, 'u2')
    assert.equal(page.rows[0]?.tokens.total, 7)
    const rest = ledger.requests({}, { limit: 2, offset: 2 })
    assert.equal(rest.rows.length, 1)
    assert.equal(rest.rows[0]?.id, 'u1')
    assert.equal(rest.rows[0]?.priced, true)
    assert.equal(rest.rows[0]?.currency, 'CNY')
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('保留策略：旧明细聚合成日汇总后删除，统计口径不变且幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-usage-rollup-'))
  const ledger = UsageLedger.open(join(dir, 'usage.sqlite'))
  try {
    const record = (
      id: string,
      at: string,
      usage: Record<string, number>,
      cost: Record<string, unknown>,
    ): void => {
      ledger.recordEvent(event({
        id,
        ts: at,
        type: 'usage.recorded',
        payload: {
          requestId: `req-${id}`,
          turn: 1,
          agentId: 'main',
          source: 'user',
          provider: 'p1',
          model: 'm1',
          usage,
          cost,
          status: 'completed',
          requestedAt: at,
          durationMs: 1000,
        },
      }))
    }
    record('old', '2026-01-05T08:00:00.000Z', { input: 100, output: 40 }, {
      currency: 'CNY', input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
      total: 2, priced: true, period: 'standard',
    })
    record('new', '2026-11-20T08:00:00.000Z', { input: 10, output: 5 }, {
      currency: 'CNY', input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0,
      total: 0.2, priced: true, period: 'standard',
    })
    ledger.recordEvent(event({
      id: 't-old',
      ts: '2026-01-05T08:00:00.000Z',
      type: 'turn.completed',
      payload: {
        steps: 1,
        turn: 1,
        usage: { input: 100, output: 40 },
        cost: { currency: 'CNY', total: 2, priced: true, period: 'standard' },
        status: 'completed',
        model: { provider: 'p1', model: 'm1' },
      },
    }))
    ledger.recordTool({
      sessionId: 's1',
      turn: 1,
      agentId: 'main',
      toolName: 'read_file',
      calls: 2,
      ok: 2,
      errors: 0,
      durationMs: 200,
      argsBytes: 4,
      resultBytes: 8,
      updatedAt: '2026-01-05T08:05:00.000Z',
    })

    const now = new Date('2026-11-22T12:00:00.000Z')
    const result = ledger.rollup({ detailDays: 30, now })
    assert.equal(result.rolledRequests, 1)
    assert.equal(result.deletedRequests, 1)
    assert.equal(result.deletedTurns, 1)
    assert.equal(result.deletedTools, 1)

    // 统计口径不变：旧的聚合行 + 新的明细行一起算。
    const overview = ledger.overview({}, { timeZone: 'utc' })
    assert.equal(overview.requests, 2)
    assert.equal(overview.tokens.input, 110)
    assert.equal(overview.tokens.output, 45)
    assert.equal(overview.costTotal, 2.2)
    assert.equal(overview.turns, 1)
    const timeline = ledger.timeline({}, { bucket: 'day', timeZone: 'utc' })
    assert.deepEqual(
      timeline.map(point => [point.bucket, point.requests, point.tokens.total]),
      [['2026-01-05', 1, 140], ['2026-11-20', 1, 15]],
    )
    const models = ledger.groups({}, { groupBy: 'model' })
    assert.equal(models[0]?.tokens.total, 155)
    const tools = ledger.groups({}, { groupBy: 'tool' })
    assert.equal(tools[0]?.requestCount, 2)

    // 明细只留保留期内的行。
    const page = ledger.requests({})
    assert.equal(page.total, 1)
    assert.equal(page.rows[0]?.id, 'new')

    const stats = ledger.stats()
    assert.equal(stats.requests, 1)
    assert.equal(stats.rollupRows, 1)
    assert.equal(stats.detailSince, '2026-11-20T08:00:00.000Z')

    // 重复执行不重复计数。
    const again = ledger.rollup({ detailDays: 30, now })
    assert.deepEqual(again, {
      rolledRequests: 0,
      rolledTurns: 0,
      rolledTools: 0,
      deletedRequests: 0,
      deletedTurns: 0,
      deletedTools: 0,
    })
    assert.equal(ledger.overview({}, { timeZone: 'utc' }).requests, 2)

    // 0 = 永久保留：不动明细。
    const keep = ledger.rollup({ detailDays: 0, now })
    assert.equal(keep.deletedRequests, 0)
    assert.equal(ledger.requests({}).total, 1)
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('API key 归属保留 id / 标签 / 掩码，原始 key 不外露', () => {
  const provider: ProviderConfig = {
    id: 'p',
    name: 'P',
    endpoints: {
      'openai-chat-completions': {
        adapterFamily: 'openai-chat-completions',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    models: [{ id: 'm' }],
    apiKeys: [
      { id: 'k1', name: '主力', key: 'sk-1234567890abcdef', isEnabled: true },
      { id: 'k2', name: '停用', key: 'sk-stopped', isEnabled: false },
    ],
    apiKey: 'sk-legacy',
  }
  const entries = resolveApiKeyEntries(provider)
  assert.deepEqual(entries.map(entry => entry.key), ['sk-1234567890abcdef', 'sk-legacy'])
  assert.deepEqual(entries.map(entry => entry.id), ['k1', undefined])
  assert.deepEqual(entries.map(entry => entry.label), ['主力', undefined])
  assert.equal(entries[0]?.masked, 'sk-1…cdef')
  assert.equal(entries[1]?.source, 'legacy')
})
