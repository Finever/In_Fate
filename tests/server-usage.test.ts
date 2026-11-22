import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from '../src/app/bundle.ts'
import { startServer } from '../src/app/server.ts'

test('用量接口：参数转译 / 分组校验 / 分页', async () => {
  const calls: Array<[string, unknown, unknown]> = []
  const app = {
    usageStats: () => ({
      requests: 3,
      turns: 1,
      tools: 2,
      legacy: 1,
      schemaVersion: 3,
      backfillDone: true,
    }),
    usageOverview: (filter: unknown, options: unknown) => {
      calls.push(['overview', filter, options])
      return { requests: 3 }
    },
    usageTimeline: (filter: unknown, options: unknown) => {
      calls.push(['timeline', filter, options])
      return []
    },
    usageGroups: (filter: unknown, options: unknown) => {
      calls.push(['groups', filter, options])
      return []
    },
    usageRequests: (filter: unknown, options: unknown) => {
      calls.push(['requests', filter, options])
      return { rows: [], total: 0, offset: 20, limit: 10 }
    },
  } as unknown as App
  const handle = await startServer(app, { port: 0, token: 't' })
  const get = (path: string): Promise<Response> =>
    fetch(`${handle.url}${path}`, { headers: { authorization: 'Bearer t' } })
  try {
    const stats = await get('/api/usage')
    assert.equal(stats.status, 200)
    assert.deepEqual(await stats.json(), {
      usage: { requests: 3, turns: 1, tools: 2, legacy: 1, schemaVersion: 3, backfillDone: true },
    })

    const overview = await get(
      '/api/usage/overview?from=2026-11-01&to=2026-11-22&agent=main&priced=true&timeZone=utc',
    )
    assert.equal(overview.status, 200)
    assert.deepEqual(calls.at(-1), [
      'overview',
      { from: '2026-11-01', to: '2026-11-22', agentId: 'main', priced: true },
      { timeZone: 'utc' },
    ])

    const timeline = await get('/api/usage/timeline?bucket=hour&source=subagent')
    assert.equal(timeline.status, 200)
    assert.deepEqual(calls.at(-1), ['timeline', { source: 'subagent' }, { bucket: 'hour' }])

    const bad = await get('/api/usage/groups?groupBy=bogus')
    assert.equal(bad.status, 400)

    const groups = await get('/api/usage/groups?groupBy=agent&limit=5&status=failed')
    assert.equal(groups.status, 200)
    assert.deepEqual(calls.at(-1), ['groups', { status: 'failed' }, { groupBy: 'agent', limit: 5 }])

    const requests = await get('/api/usage/requests?limit=10&offset=20&recordKind=legacy-aggregate')
    assert.equal(requests.status, 200)
    const page = (await requests.json()) as { page: { total: number } }
    assert.equal(page.page.total, 0)
    assert.deepEqual(calls.at(-1), [
      'requests',
      { recordKind: 'legacy-aggregate' },
      { limit: 10, offset: 20 },
    ])
  } finally {
    await handle.close()
  }
})
