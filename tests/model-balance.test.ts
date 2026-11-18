import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BalanceQueryError,
  BalanceUnsupportedError,
  ModelBalanceService,
  type BalanceFetch,
} from '../src/model/balance.ts'
import type { ProviderConfig } from '../src/model/types.ts'

function provider(id: string, baseUrl: string): ProviderConfig {
  return {
    id,
    name: id,
    endpoints: {
      'openai-chat-completions': {
        adapterFamily: 'openai-chat-completions',
        baseUrl,
      },
    },
    models: [],
  }
}

function fakeFetch(body: unknown, status = 200): {
  fetch: BalanceFetch
  calls: Array<{ url: string; authorization: string }>
} {
  const calls: Array<{ url: string; authorization: string }> = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

test('DeepSeek 余额：官方 URL、Bearer key、字符串金额归一化', async () => {
  const fake = fakeFetch({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '12.34',
      granted_balance: '2.00',
      topped_up_balance: '10.34',
    }],
  })
  const service = new ModelBalanceService({
    fetch: fake.fetch,
    now: () => new Date('2026-11-15T00:00:00.000Z'),
  })
  const balance = await service.query({
    provider: provider('deepseek', 'https://api.deepseek.com/v1'),
    keyId: 'k1',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com/v1',
  })
  assert.equal(fake.calls[0]!.url, 'https://api.deepseek.com/user/balance')
  assert.equal(fake.calls[0]!.authorization, 'Bearer sk-test')
  assert.deepEqual(balance.balances, [{
    currency: 'CNY',
    total: 12.34,
    available: 12.34,
    granted: 2,
    toppedUp: 10.34,
  }])
  assert.equal(balance.checkedAt, '2026-11-15T00:00:00.000Z')
})

test('Moonshot 余额：读取 data.available/cash/voucher', async () => {
  const fake = fakeFetch({
    code: 0,
    data: {
      available_balance: '8.5',
      voucher_balance: '1.5',
      cash_balance: '7',
    },
  })
  const service = new ModelBalanceService({ fetch: fake.fetch })
  const balance = await service.query({
    provider: provider('moonshot', 'https://api.moonshot.cn/v1'),
    keyId: 'k2',
    apiKey: 'sk-moon',
    baseUrl: 'https://api.moonshot.cn/v1',
  })
  assert.equal(fake.calls[0]!.url, 'https://api.moonshot.cn/v1/users/me/balance')
  assert.deepEqual(balance.balances, [{
    currency: 'CNY',
    total: 8.5,
    available: 8.5,
    granted: 1.5,
    toppedUp: 7,
  }])
})

test('OpenRouter 余额：credits - usage', async () => {
  const fake = fakeFetch({
    data: { total_credits: 100, total_usage: 25.5 },
  })
  const service = new ModelBalanceService({ fetch: fake.fetch })
  const balance = await service.query({
    provider: provider('openrouter', 'https://openrouter.ai/api/v1'),
    keyId: 'k3',
    apiKey: 'sk-or',
    baseUrl: 'https://openrouter.ai/api/v1',
  })
  assert.equal(fake.calls[0]!.url, 'https://openrouter.ai/api/v1/credits')
  assert.deepEqual(balance.balances, [{
    currency: 'USD',
    total: 100,
    available: 74.5,
    totalUsage: 25.5,
  }])
})

test('不支持的厂商明确拒绝，不猜端点', async () => {
  const service = new ModelBalanceService({ fetch: fakeFetch({}).fetch })
  const openai = provider('openai', 'https://api.openai.com/v1')
  assert.equal(service.supports(openai, 'https://api.openai.com/v1'), false)
  await assert.rejects(
    () => service.query({
      provider: openai,
      keyId: 'k4',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
    }),
    (error: unknown) =>
      error instanceof BalanceUnsupportedError
      && error.code === 'balance_unsupported',
  )
})

test('401/403 区分成 key 无账单权限', async () => {
  const service = new ModelBalanceService({
    fetch: fakeFetch({ error: 'unauthorized' }, 401).fetch,
  })
  await assert.rejects(
    () => service.query({
      provider: provider('deepseek', 'https://api.deepseek.com/v1'),
      keyId: 'k5',
      apiKey: 'sk-bad',
      baseUrl: 'https://api.deepseek.com/v1',
    }),
    (error: unknown) =>
      error instanceof BalanceQueryError
      && error.status === 401
      && /401\/403/.test(error.message),
  )
})

test('余额查询超时给出明确错误', async () => {
  const service = new ModelBalanceService({
    timeoutMs: 10,
    fetch: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  await assert.rejects(
    () => service.query({
      provider: provider('deepseek', 'https://api.deepseek.com/v1'),
      keyId: 'k-timeout',
      apiKey: 'sk-timeout',
      baseUrl: 'https://api.deepseek.com/v1',
    }),
    (error: unknown) =>
      error instanceof BalanceQueryError
      && /超时/.test(error.message),
  )
})

test('余额结果缓存 60 秒，过期后重新请求', async () => {
  let clock = 1_700_000_000_000
  const fake = fakeFetch({
    data: { total_credits: 10, total_usage: 1 },
  })
  const service = new ModelBalanceService({
    fetch: fake.fetch,
    now: () => new Date(clock),
    ttlMs: 60_000,
  })
  const input = {
    provider: provider('openrouter', 'https://openrouter.ai/api/v1'),
    keyId: 'k6',
    apiKey: 'sk-cache',
    baseUrl: 'https://openrouter.ai/api/v1',
  }
  await service.query(input)
  await service.query(input)
  assert.equal(fake.calls.length, 1)
  await service.query({ ...input, force: true })
  assert.equal(fake.calls.length, 2)
  clock += 60_001
  await service.query(input)
  assert.equal(fake.calls.length, 3)
})
