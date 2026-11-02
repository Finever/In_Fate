import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'

test('读取 provider 模型列表并手动追加模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-model-probe-'))
  const dataRoot = join(dir, 'data')
  const configPath = join(dir, 'if.json')
  mkdirSync(dataRoot, { recursive: true })

  const mock = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer secret') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }))
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  const port = (mock.address() as AddressInfo).port

  const config: AppConfig = {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [{
      id: 'fake',
      name: 'Fake',
      apiKey: 'secret',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai-chat-completions',
          baseUrl: `http://127.0.0.1:${port}/v1`,
        },
      },
      models: [],
    }],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const app = buildBundle(config, new Container(), { configPath })
  try {
    const probed = await app.probeModelProvider({ provider: 'fake' })
    assert.deepEqual(probed.models, ['m1', 'm2'])

    const withModel = await app.addProviderModels({
      provider: 'fake',
      models: [
        { id: 'm1' },
        { id: 'm3', contextWindow: 32_000, maxOutputTokens: 4_096 },
      ],
    })
    const fake = withModel.providers.find(provider => provider.id === 'fake')
    assert.deepEqual(fake?.models.map(model => model.id), ['m1', 'm3'])
    assert.equal(fake?.models.find(model => model.id === 'm3')?.contextWindow, 32_000)

    const duplicate = await app.addProviderModels({
      provider: 'fake',
      models: [{ id: 'm1' }, { id: 'm3' }],
    })
    const fakeAgain = duplicate.providers.find(provider => provider.id === 'fake')
    assert.deepEqual(fakeAgain?.models.map(model => model.id), ['m1', 'm3'])

    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{ id: string; models: Array<{ id: string }> }>
    }
    const raw = disk.providers.find(provider => provider.id === 'fake')
    assert.deepEqual(raw?.models.map(model => model.id), ['m1', 'm3'])
  } finally {
    await app.dispose()
    await new Promise<void>(resolve => mock.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
