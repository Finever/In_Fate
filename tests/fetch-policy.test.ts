import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { NetworkPolicy } from '../src/core/network-policy.ts'
import { fetchTool } from '../src/tools/builtin/fetch.ts'

test('fetch 遵守注入的网络策略', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('local ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const base = {
    sessionId: 's',
    callId: 'c',
    cwd: process.cwd(),
    signal: new AbortController().signal,
  }

  try {
    await assert.rejects(
      fetchTool.run({ url }, { ...base, network: new NetworkPolicy() }),
      /network policy/,
    )

    const result = await fetchTool.run(
      { url },
      { ...base, network: new NetworkPolicy({ allowPrivateNetwork: true }) },
    )
    assert.equal(result.text, 'local ok')
    const structured = result.structured as { url?: string; redirects?: number }
    assert.equal(structured.url, url)
    assert.equal(structured.redirects, 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
