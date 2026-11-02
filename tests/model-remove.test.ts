import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { seedAgentModel } from './support.ts'

function provider(id: string): AppConfig['providers'][number] {
  return {
    id,
    name: id,
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': {
        adapterFamily: 'openai-chat-completions',
        baseUrl: `http://127.0.0.1/${id}/v1`,
      },
    },
    models: [{ id: 'm1' }],
  }
}

test('删除服务商：内置拒绝、被 agent 使用拒绝、自建可删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-model-remove-'))
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
    providers: [provider('fake1'), provider('fake2')],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const app = buildBundle(config, new Container(), { configPath })
  try {
    await assert.rejects(() => app.removeModelProvider('deepseek'), /内置/)
    await assert.rejects(() => app.removeModelProvider('missing'), /unknown provider/)

    const afterFake2 = await app.removeModelProvider('fake2')
    assert.equal(afterFake2.providers.some(item => item.id === 'fake2'), false)
    assert.equal(afterFake2.providers.some(item => item.id === 'fake1'), true)
    const disk1 = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{ id: string }>
    }
    assert.equal(disk1.providers.some(item => item.id === 'fake2'), false)

    seedAgentModel(dataRoot, { provider: 'fake1', model: 'm1' })
    await assert.rejects(() => app.removeModelProvider('fake1'), /正在使用/)

    rmSync(join(dataRoot, 'agents', 'main', 'settings.json'), { force: true })
    const afterFake1 = await app.removeModelProvider('fake1')
    assert.equal(afterFake1.providers.some(item => item.id === 'fake1'), false)
    assert.equal(afterFake1.providers.some(item => item.id === 'deepseek'), true)
    const disk2 = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<{ id: string }>
    }
    assert.deepEqual(disk2.providers, [])
  } finally {
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
