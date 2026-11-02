import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { startServer } from '../src/app/server.ts'

function configFor(dataRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [{
      id: 'fake',
      name: 'Fake Provider',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
      },
      models: [
        { id: 'm', contextWindow: 128_000, maxOutputTokens: 4_096 },
        { id: 'm2' },
      ],
    }],
    presets: [],
    defaultModel: { provider: 'fake', model: 'm' },
    patch: { tools: { enabled: [] } },
  }
}

test('模型配置：provider 凭据、模型卡与价格写回，view 不回传 key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-model-config-'))
  const dataRoot = join(dir, 'data')
  const configPath = join(dir, 'if.json')
  mkdirSync(dataRoot, { recursive: true })
  const config = configFor(dataRoot)
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const app = buildBundle(config, new Container(), { configPath })
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  }
  try {
    const initial = await fetch(`${handle.url}/api/model-config`, { headers })
    assert.equal(initial.status, 200)
    const initialText = await initial.text()
    assert.doesNotMatch(initialText, /"apiKey"\s*:/)
    assert.doesNotMatch(initialText, /defaultModel/)
    const initialBody = JSON.parse(initialText) as {
      config: {
        timeZone: string
        providers: Array<{
          hasApiKey: boolean
          models: Array<{ id: string; contextWindow?: number }>
        }>
      }
    }
    assert.equal(initialBody.config.timeZone, 'Asia/Shanghai')
    assert.equal(initialBody.config.providers[0]!.hasApiKey, false)
    assert.equal(initialBody.config.providers[0]!.models[0]!.contextWindow, 128_000)

    const saved = await fetch(`${handle.url}/api/model-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'fake',
        apiKey: 'secret-key',
        baseUrl: 'http://127.0.0.1:2/v1',
      }),
    })
    assert.equal(saved.status, 200)
    const savedText = await saved.text()
    assert.doesNotMatch(savedText, /secret-key/)
    const savedBody = JSON.parse(savedText) as {
      config: {
        providers: Array<{ hasApiKey: boolean; baseUrl: string }>
      }
    }
    assert.equal(savedBody.config.providers[0]!.hasApiKey, true)
    assert.equal(savedBody.config.providers[0]!.baseUrl, 'http://127.0.0.1:2/v1')

    const pricing = {
      input: { currency: 'CNY', perMillionTokens: 1 },
      output: { currency: 'CNY', perMillionTokens: 8 },
      cacheRead: { currency: 'CNY', perMillionTokens: 0.1 },
      offPeak: {
        input: { currency: 'CNY', perMillionTokens: 0.5 },
        windows: [{ start: '00:30', end: '08:30' }],
      },
    }
    const card = await fetch(`${handle.url}/api/model-config/models/fake/m`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        pricing,
      }),
    })
    assert.equal(card.status, 200)
    const cardBody = await card.json() as {
      config: { providers: Array<{ models: Array<{ id: string; contextWindow?: number; pricing?: unknown }> }> }
    }
    const model = cardBody.config.providers[0]!.models.find(item => item.id === 'm')
    assert.equal(model?.contextWindow, 200_000)
    assert.deepEqual(model?.pricing, pricing)

    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{
        apiKey?: string
        endpoints: Record<string, { baseUrl: string }>
        models: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number; pricing?: unknown }>
      }>
    }
    assert.equal(disk.providers[0]!.apiKey, 'secret-key')
    assert.equal(
      disk.providers[0]!.endpoints['openai-chat-completions']!.baseUrl,
      'http://127.0.0.1:2/v1',
    )
    const diskModel = disk.providers[0]!.models.find(item => item.id === 'm')
    assert.equal(diskModel?.contextWindow, 200_000)
    assert.equal(diskModel?.maxOutputTokens, 8_192)
    assert.deepEqual(diskModel?.pricing, pricing)

    const invalid = await fetch(`${handle.url}/api/model-config/models/fake/nope`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ contextWindow: 1000 }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('内置只做模板；添加服务商写入配置并拒绝重复 id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-model-add-'))
  const dataRoot = join(dir, 'data')
  const configPath = join(dir, 'if.json')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(configFor(dataRoot), null, 2)}\n`, 'utf8')

  const app = buildBundle(configFor(dataRoot), new Container(), { configPath })
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  }
  try {
    const initial = await fetch(`${handle.url}/api/model-config`, { headers })
    assert.equal(initial.status, 200)
    const initialBody = await initial.json() as {
      config: { providers: Array<{ id: string }> }
    }
    const ids = initialBody.config.providers.map(provider => provider.id)
    assert.equal(ids.includes('fake'), true)
    assert.equal(ids.includes('deepseek'), false)
    assert.equal(ids.includes('openai'), false)

    const templates = await fetch(`${handle.url}/api/model-config/templates`, { headers })
    assert.equal(templates.status, 200)
    const templateBody = await templates.json() as { providers: Array<{ id: string }> }
    const templateIds = templateBody.providers.map(provider => provider.id)
    assert.equal(templateIds.includes('deepseek'), true)
    assert.equal(templateIds.includes('openai'), true)

    const created = await fetch(`${handle.url}/api/model-config/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'custom',
        name: 'Custom Provider',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'secret-key',
        apiKeyEnv: 'CUSTOM_API_KEY',
        models: [
          { id: 'x', name: 'X', contextWindow: 32_000, maxOutputTokens: 4_096 },
        ],
      }),
    })
    assert.equal(created.status, 200)
    const createdBody = await created.json() as {
      config: { providers: Array<{ id: string; hasApiKey: boolean; baseUrl: string }> }
    }
    const added = createdBody.config.providers.find(provider => provider.id === 'custom')
    assert.ok(added)
    assert.equal(added?.hasApiKey, true)
    assert.equal(added?.baseUrl, 'http://127.0.0.1:9/v1')

    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{
        id: string
        apiKey?: string
        apiKeyEnv?: string
        endpoints?: Record<string, { baseUrl?: string }>
        models?: Array<{ id: string; contextWindow?: number }>
      }>
    }
    const raw = disk.providers.find(provider => provider.id === 'custom')
    assert.ok(raw)
    assert.equal(raw?.apiKey, 'secret-key')
    assert.equal(raw?.apiKeyEnv, 'CUSTOM_API_KEY')
    assert.equal(raw?.endpoints?.['openai-chat-completions']?.baseUrl, 'http://127.0.0.1:9/v1')
    assert.equal(raw?.models?.find(model => model.id === 'x')?.contextWindow, 32_000)

    const duplicate = await fetch(`${handle.url}/api/model-config/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'custom',
        name: 'Custom Again',
        baseUrl: 'http://127.0.0.1:10/v1',
        models: [{ id: 'x' }],
      }),
    })
    assert.equal(duplicate.status, 400)

    const fromTemplate = await fetch(`${handle.url}/api/model-config/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        format: 'openai-chat-completions',
        models: [],
      }),
    })
    assert.equal(fromTemplate.status, 200)
    const fromTemplateBody = await fromTemplate.json() as {
      config: { providers: Array<{ id: string }> }
    }
    assert.equal(fromTemplateBody.config.providers.some(provider => provider.id === 'deepseek'), true)

    const builtinDuplicate = await fetch(`${handle.url}/api/model-config/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'deepseek',
        name: 'DeepSeek Again',
        baseUrl: 'http://127.0.0.1:11/v1',
        models: [{ id: 'x' }],
      }),
    })
    assert.equal(builtinDuplicate.status, 400)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
