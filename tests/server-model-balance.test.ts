import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from '../src/app/bundle.ts'
import { startServer } from '../src/app/server.ts'
import {
  BalanceInputError,
  BalanceQueryError,
  BalanceUnsupportedError,
  type ModelBalance,
} from '../src/model/balance.ts'

const balance: ModelBalance = {
  provider: 'deepseek',
  keyId: 'k1',
  checkedAt: '2026-11-15T00:00:00.000Z',
  source: 'api',
  balances: [{
    currency: 'CNY',
    total: 12.34,
    available: 12.34,
  }],
}

test('模型余额 HTTP：成功、不支持、输入错误和上游失败', async () => {
  const app = {
    modelBalance: async (input: { provider: string }) => {
      if (input.provider === 'deepseek') return balance
      if (input.provider === 'openai') throw new BalanceUnsupportedError('no balance API')
      if (input.provider === 'bad-key') throw new BalanceInputError('unknown api key')
      throw new BalanceQueryError('upstream down', 502)
    },
  } as unknown as App
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  try {
    const headers = { authorization: 'Bearer test-token' }
    const url = (provider: string, keyId: string): string =>
      `${handle.url}/api/model-config/providers/${provider}/api-keys/${keyId}/balance`

    const ok = await fetch(url('deepseek', 'k1'), { headers })
    assert.equal(ok.status, 200)
    assert.deepEqual((await ok.json() as { balance: ModelBalance }).balance, balance)

    const unsupported = await fetch(url('openai', 'k1'), { headers })
    assert.equal(unsupported.status, 400)
    assert.equal(
      (await unsupported.json() as { code: string }).code,
      'balance_unsupported',
    )

    const input = await fetch(url('bad-key', 'k1'), { headers })
    assert.equal(input.status, 400)
    assert.equal((await input.json() as { code: string }).code, 'balance_input')

    const upstream = await fetch(url('moonshot', 'k1'), { headers })
    assert.equal(upstream.status, 502)
    assert.equal(
      (await upstream.json() as { code: string }).code,
      'balance_unavailable',
    )
  } finally {
    await handle.close()
  }
})
