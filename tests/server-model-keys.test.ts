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
      name: 'Fake',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai-chat-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
      },
      models: [{ id: 'm' }],
    }],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
}

test('多 API key：添加、停用、删除，视图只给脱敏预览', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-model-keys-'))
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
  const keysUrl = `${handle.url}/api/model-config/providers/fake/api-keys`

  try {
    const first = await fetch(keysUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'sk-first-secret', isEnabled: true }),
    })
    assert.equal(first.status, 200)
    const firstText = await first.text()
    assert.doesNotMatch(firstText, /sk-first-secret/)
    const firstBody = JSON.parse(firstText) as {
      config: {
        providers: Array<{
          hasApiKey: boolean
          apiKeys: Array<{ id: string; preview: string; isEnabled: boolean }>
        }>
      }
    }
    const firstKeys = firstBody.config.providers[0]!.apiKeys
    assert.equal(firstBody.config.providers[0]!.hasApiKey, true)
    assert.equal(firstKeys.length, 1)
    assert.equal(firstKeys[0]!.isEnabled, true)
    assert.doesNotMatch(firstKeys[0]!.preview, /secret/)
    const firstId = firstKeys[0]!.id

    const second = await fetch(keysUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'sk-second-secret' }),
    })
    assert.equal(second.status, 200)
    const secondBody = await second.json() as {
      config: {
        providers: Array<{
          hasApiKey: boolean
          apiKeys: Array<{ id: string; preview: string; isEnabled: boolean }>
        }>
      }
    }
    const keys = secondBody.config.providers[0]!.apiKeys
    assert.equal(keys.length, 2)
    assert.equal(keys.filter(key => key.isEnabled).length, 2)

    const duplicate = await fetch(keysUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'sk-first-secret' }),
    })
    assert.equal(duplicate.status, 400)

    const disabled = await fetch(`${keysUrl}/${firstId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ isEnabled: false }),
    })
    assert.equal(disabled.status, 200)
    const disabledBody = await disabled.json() as {
      config: { providers: Array<{ apiKeys: Array<{ id: string; isEnabled: boolean }> }> }
    }
    assert.equal(
      disabledBody.config.providers[0]!.apiKeys.find(key => key.id === firstId)!.isEnabled,
      false,
    )

    const secondId = keys.find(key => key.id !== firstId)!.id
    const removed = await fetch(`${keysUrl}/${secondId}`, { method: 'DELETE', headers })
    assert.equal(removed.status, 200)
    const removedBody = await removed.json() as {
      config: {
        providers: Array<{
          hasApiKey: boolean
          apiKeys: Array<{ id: string; isEnabled: boolean }>
        }>
      }
    }
    assert.equal(removedBody.config.providers[0]!.apiKeys.length, 1)
    assert.equal(removedBody.config.providers[0]!.hasApiKey, false)

    const unknown = await fetch(`${keysUrl}/nope`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(unknown.status, 400)

    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{
        apiKeys?: Array<{ id: string; key: string; isEnabled?: boolean }>
      }>
    }
    assert.equal(disk.providers[0]!.apiKeys?.length, 1)
    assert.equal(disk.providers[0]!.apiKeys?.[0]!.key, 'sk-first-secret')
    assert.equal(disk.providers[0]!.apiKeys?.[0]!.isEnabled, false)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('多端点格式：一次加入、按格式改 baseUrl、探测按格式选接口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-model-formats-'))
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
    const created = await fetch(`${handle.url}/api/model-config/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'multi',
        name: 'Multi',
        baseUrl: 'http://127.0.0.1:9/v1',
        format: 'openai-chat-completions',
        endpoints: {
          'openai-chat-completions': { baseUrl: 'http://127.0.0.1:9/v1' },
          'anthropic-messages': { baseUrl: 'http://127.0.0.1:9/anthropic' },
        },
        models: [],
      }),
    })
    assert.equal(created.status, 200)
    const createdBody = await created.json() as {
      config: {
        providers: Array<{
          id: string
          endpointFamily: string
          endpointFamilies: string[]
          baseUrl: string
          endpoints: Array<{ family: string; baseUrl: string }>
        }>
      }
    }
    const provider = createdBody.config.providers.find(item => item.id === 'multi')!
    assert.equal(provider.endpointFamily, 'openai-chat-completions')
    assert.deepEqual(provider.endpointFamilies.sort(), [
      'anthropic-messages',
      'openai-chat-completions',
    ])
    assert.equal(provider.baseUrl, 'http://127.0.0.1:9/v1')

    const changed = await fetch(`${handle.url}/api/model-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'multi',
        format: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:9/anthropic/v1',
      }),
    })
    assert.equal(changed.status, 200)
    const changedBody = await changed.json() as {
      config: {
        providers: Array<{
          id: string
          baseUrl: string
          endpoints: Array<{ family: string; baseUrl: string }>
        }>
      }
    }
    const changedProvider = changedBody.config.providers.find(item => item.id === 'multi')!
    assert.equal(changedProvider.baseUrl, 'http://127.0.0.1:9/v1')
    assert.equal(
      changedProvider.endpoints.find(item => item.family === 'anthropic-messages')?.baseUrl,
      'http://127.0.0.1:9/anthropic/v1',
    )

    const badFormat = await fetch(`${handle.url}/api/model-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'multi',
        format: 'google-generate-content',
        baseUrl: 'http://127.0.0.1:9',
      }),
    })
    assert.equal(badFormat.status, 400)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
