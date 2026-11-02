import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { ModelRegistry } from '../src/model/registry.ts'
import type { ProviderConfig } from '../src/model/types.ts'

const provider: ProviderConfig = {
  id: 'p',
  name: 'P',
  defaultChatEndpoint: 'openai-chat-completions',
  endpoints: {
    'openai-chat-completions': {
      adapterFamily: 'openai-chat-completions',
      baseUrl: 'http://127.0.0.1/p/v1',
    },
  },
  models: [{ id: 'm' }],
}

test('registry 拒绝停用的 provider / model', () => {
  const registry = new ModelRegistry()
  registry.register(provider)
  assert.equal(registry.resolve('p', 'm').model.id, 'm')

  registry.setEnabled('p', false)
  assert.throws(() => registry.resolve('p', 'm'), /provider is disabled/)
  registry.setEnabled('p', true)

  registry.setModelEnabled('p', 'm', false)
  assert.throws(() => registry.resolve('p', 'm'), /model is disabled/)
  registry.setModelEnabled('p', 'm', true)
  assert.equal(registry.resolve('p', 'm').model.id, 'm')
})

test('启用状态写回配置并出现在 view', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-model-enabled-'))
  const dataRoot = join(dir, 'data')
  const configPath = join(dir, 'if.json')
  mkdirSync(dataRoot, { recursive: true })
  const config: AppConfig = {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [provider],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const app = buildBundle(config, new Container(), { configPath })
  try {
    const disabledProvider = await app.saveModelConfig({ provider: 'p', enabled: false })
    assert.equal(disabledProvider.providers[0]?.enabled, false)

    const disabledModel = await app.saveModelCard({
      provider: 'p',
      model: 'm',
      enabled: false,
    })
    assert.equal(disabledModel.providers[0]?.models[0]?.enabled, false)

    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{ enabled?: boolean; models: Array<{ enabled?: boolean }> }>
    }
    assert.equal(disk.providers[0]?.enabled, false)
    assert.equal(disk.providers[0]?.models[0]?.enabled, false)

    const restored = await app.saveModelConfig({ provider: 'p', enabled: true })
    assert.equal(restored.providers[0]?.enabled, true)
  } finally {
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
