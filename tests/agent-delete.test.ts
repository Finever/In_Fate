import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'

function configFor(dataRoot: string, memoryRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      memoryLogRoot: memoryRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [{
      id: 'fake',
      name: 'fake',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai',
          baseUrl: 'http://127.0.0.1:1',
        },
      },
      models: [{ id: 'm' }],
      apiKey: 'test',
    }],
    presets: [],
    defaultModel: { provider: 'fake', model: 'm' },
    patch: { tools: { enabled: [] } },
  }
}

test('agent 删除：默认主 agent 拒绝、有会话拒绝、无会话移入 .trash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-agent-delete-'))
  const dataRoot = join(dir, 'data')
  const memoryRoot = join(dir, 'memory')
  mkdirSync(dataRoot, { recursive: true })
  const app = buildBundle(configFor(dataRoot, memoryRoot), new Container())
  try {
    await assert.rejects(
      () => app.createMainAgent({ id: '.trash', name: '保留名' }),
      /unsafe agent id|unsafe agent/,
    )
    await app.createMainAgent({ id: 'other', name: '其他 agent' })
    await app.updateAgentSettings('other', {})

    const main = app.agentSummary('main')
    assert.equal(main.deletable, false)
    assert.match(main.deleteBlockedReason ?? '', /默认主 agent/)

    const other = app.agentSummary('other')
    assert.equal(other.sessionCount, 0)
    assert.equal(other.deletable, true)

    const sessionId = app.createSession({ agentId: 'other', createdBy: 'user', materialize: true })
    const blocked = app.agentSummary('other')
    assert.equal(blocked.sessionCount, 1)
    assert.equal(blocked.deletable, false)
    await assert.rejects(() => app.deleteMainAgent('other'), /还有 1 个未删除的会话/)
    assert.equal(existsSync(join(memoryRoot, 'agents', 'other')), true)

    app.deleteSession(sessionId, { reason: 'test' })
    assert.equal(app.agentSummary('other').deletable, true)

    const deleted = await app.deleteMainAgent('other')
    assert.equal(deleted.id, 'other')
    assert.equal(deleted.trash.length, 2)
    assert.equal(existsSync(join(memoryRoot, 'agents', 'other')), false)
    assert.equal(existsSync(join(dataRoot, 'agents', 'other')), false)
    assert.equal(
      readdirSync(join(memoryRoot, 'agents', '.trash')).some(name => name.startsWith('other-')),
      true,
    )
    assert.equal(
      readdirSync(join(dataRoot, 'agents', '.trash')).some(name => name.startsWith('other-')),
      true,
    )
    assert.equal(app.agentSummaries().some(agent => agent.id === 'other'), false)
  } finally {
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})