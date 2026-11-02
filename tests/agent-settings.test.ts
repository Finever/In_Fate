import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentSettingsStore } from '../src/agents/settings.ts'

test('agent 设置：模型、子 agent 列表、工具策略与原子写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-agent-settings-'))
  try {
    const store = new AgentSettingsStore(dir)
    const settings = await store.write({
      version: 1,
      agentId: 'main',
      models: {
        main: { provider: 'p', model: 'm' },
        subagents: [{ provider: 'p', model: 'm2' }],
      },
      subagentPresets: ['research'],
      tools: {
        allow: ['read'],
        approval: { write: 'required' },
      },
    })
    assert.deepEqual(settings.models?.subagents, [
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm2' },
    ])
    const disk = JSON.parse(readFileSync(store.path('main'), 'utf8')) as {
      models: { subagents: unknown[] }
      tools: { allow: string[] }
    }
    assert.equal(disk.models.subagents.length, 2)
    assert.deepEqual(disk.tools.allow, ['read'])

    const updated = await store.update('main', current => ({
      ...current,
      models: {
        main: { provider: 'p', model: 'm3' },
        subagents: current.models?.subagents ?? [],
      },
    }))
    assert.deepEqual(updated.models?.subagents, [
      { provider: 'p', model: 'm3' },
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm2' },
    ])
    assert.equal(store.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('agent 设置拒绝不安全 id、重复模型与非法审批', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-agent-settings-bad-'))
  try {
    const store = new AgentSettingsStore(dir)
    assert.throws(() => store.path('../escape'))
    await assert.rejects(() => store.write({
      version: 1,
      agentId: 'main',
      models: {
        subagents: [
          { provider: 'p', model: 'm' },
          { provider: 'p', model: 'm' },
        ],
      },
      tools: {
        approval: { read: 'sometimes' as never },
      },
    }))
    assert.equal(store.read('main'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
