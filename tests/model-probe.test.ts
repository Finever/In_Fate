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

test('探测按端点格式选接口与鉴权头', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-model-probe-format-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })

  const mock = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers['x-api-key'] === 'anthropic-key') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'claude-1' }] }))
      return
    }
    if (req.url === '/v1beta/models'
      && req.headers['x-goog-api-key'] === 'google-key') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-1' }] }))
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  const port = (mock.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  const config: AppConfig = {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
  const app = buildBundle(config, new Container())
  try {
    await app.addModelProvider({
      id: 'native',
      name: 'Native',
      baseUrl,
      format: 'anthropic-messages',
      apiKey: 'anthropic-key',
      endpoints: {
        'anthropic-messages': { baseUrl },
        'google-generate-content': { baseUrl },
      },
      models: [],
    })
    const anthropic = await app.probeModelProvider({
      provider: 'native',
      format: 'anthropic-messages',
    })
    assert.deepEqual(anthropic.models, ['claude-1'])

    const google = await app.probeModelProvider({
      provider: 'native',
      format: 'google-generate-content',
      apiKey: 'google-key',
    })
    assert.deepEqual(google.models, ['gemini-1'])
  } finally {
    await app.dispose()
    await new Promise<void>(resolve => mock.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('默认端点不支持 /models 时回退到同 provider 的其他端点', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-model-probe-fallback-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })

  const mock = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers['x-api-key'] === 'secret') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: 'Not Found (request_id: test)',
          type: 'not_found_error',
          param: null,
          code: 'invalid_request_error',
        },
      }))
      return
    }
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer secret') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  const port = (mock.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  const config: AppConfig = {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
  const app = buildBundle(config, new Container())
  try {
    await app.addModelProvider({
      id: 'fallback',
      name: 'Fallback',
      baseUrl,
      format: 'anthropic-messages',
      apiKey: 'secret',
      endpoints: {
        'openai-chat-completions': { baseUrl: `${baseUrl}/v1` },
      },
      models: [],
    })
    const probed = await app.probeModelProvider({ provider: 'fallback' })
    assert.deepEqual(probed.models, ['m1', 'm2'])
  } finally {
    await app.dispose()
    await new Promise<void>(resolve => mock.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

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

    const native = await app.addModelProvider({
      id: 'native',
      name: 'Native',
      baseUrl: 'http://127.0.0.1:1',
      format: 'anthropic-messages',
      models: [],
    })
    const nativeProvider = native.providers.find(provider => provider.id === 'native')
    assert.equal(nativeProvider?.endpointFamily, 'anthropic-messages')
    assert.deepEqual(nativeProvider?.endpointFamilies, ['anthropic-messages'])

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
