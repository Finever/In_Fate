import assert from 'node:assert/strict'
import test from 'node:test'
import { PresetRegistry } from '../src/agents/presets.ts'
import type { AgentPreset } from '../src/agents/types.ts'
import { createRequestAgentTool, modelListTool } from '../src/tools/builtin/request-agent.ts'

const preset: AgentPreset = {
  id: 'research',
  description: '查资料',
  models: [
    { provider: 'p', model: 'm' },
    { provider: 'p', model: 'm2' },
  ],
  tools: ['read', 'write'],
  maxSteps: 2,
  timeoutMs: 10_000,
  readOnly: false,
}

function registry(): PresetRegistry {
  const presets = new PresetRegistry()
  presets.register(preset)
  return presets
}

test('request_agent 按主 agent 策略收窄模型和工具，并拒绝越权模型', async () => {
  const presets = registry()
  let submitted: AgentPreset | undefined
  const manager = {
    submit(_input: unknown, effective: AgentPreset) {
      submitted = effective
      return { id: 'req-1' }
    },
    queueLength: () => 0,
    activeCount: () => 0,
  }
  const tool = createRequestAgentTool({
    manager: manager as never,
    presets,
    resolvePolicy: () => ({
      models: [{ provider: 'p', model: 'm2' }],
      mainModel: { provider: 'p', model: 'm2' },
      presets: ['research'],
      toolAllow: ['read'],
    }),
  })

  const accepted = await tool.run({
    preset: 'research',
    prompt: '查一下',
    model: { provider: 'p', model: 'm2' },
  }, { sessionId: 's' } as never)
  assert.equal(accepted.isError, undefined)
  assert.deepEqual(submitted?.models, [{ provider: 'p', model: 'm2' }])
  assert.deepEqual(submitted?.tools, ['read'])

  const denied = await tool.run({
    preset: 'research',
    prompt: '查一下',
    model: { provider: 'p', model: 'm' },
  }, { sessionId: 's' } as never)
  assert.equal(denied.isError, true)
  assert.match(String(denied.text), /not allowed/)

  const noModel = await tool.run({ preset: 'research', prompt: '查一下' }, { sessionId: 's' } as never)
  assert.equal(noModel.isError, undefined)
  assert.deepEqual(submitted?.models, [{ provider: 'p', model: 'm2' }])
})

test('model_list 返回当前 agent 的主模型、子 agent 模型和预设', async () => {
  const tool = modelListTool({
    presets: registry(),
    resolvePolicy: () => ({
      models: [{ provider: 'p', model: 'm2' }],
      mainModel: { provider: 'p', model: 'm2' },
      presets: ['research'],
    }),
  })
  const result = await tool.run({}, { sessionId: 's' } as never)
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structured, {
    mainModel: { provider: 'p', model: 'm2' },
    models: [{ provider: 'p', model: 'm2' }],
    presets: ['research'],
  })
})
