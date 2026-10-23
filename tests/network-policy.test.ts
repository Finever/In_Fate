import assert from 'node:assert/strict'
import test from 'node:test'
import { NetworkPolicy } from '../src/core/network-policy.ts'

const publicLookup = async (): Promise<{ address: string; family: number }[]> => [
  { address: '93.184.216.34', family: 4 },
]

test('默认拒绝本机、私网与云元数据地址', async () => {
  const policy = new NetworkPolicy({ lookup: publicLookup })
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'ftp://example.com/file',
  ]) {
    await assert.rejects(policy.check(url), /network policy|unsupported protocol/, url)
  }
})

test('公网域名解析到公网地址才放行', async () => {
  const policy = new NetworkPolicy({ lookup: publicLookup })
  const url = await policy.check('https://example.com/path')
  assert.equal(url.hostname, 'example.com')

  const privateDns = new NetworkPolicy({
    lookup: async () => [{ address: '10.0.0.7', family: 4 }],
  })
  await assert.rejects(privateDns.check('https://evil.example/'), /private address/)
})

test('allowHosts 与 denyHosts 的优先级', async () => {
  const policy = new NetworkPolicy({
    allowHosts: ['localhost', '*.internal'],
    denyHosts: ['bad.internal'],
    lookup: publicLookup,
  })
  await assert.doesNotReject(policy.check('http://localhost:8787/'))
  await assert.doesNotReject(policy.check('http://api.internal/'))
  await assert.rejects(policy.check('http://bad.internal/'), /host denied/)
})

test('服务端抓取只做字面量检查', async () => {
  const policy = new NetworkPolicy({ lookup: publicLookup })
  await assert.doesNotReject(policy.check('https://example.com/', { resolve: false }))
  await assert.rejects(
    policy.check('http://169.254.169.254/', { resolve: false }),
    /private address/,
  )
})
