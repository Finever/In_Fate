import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedToolNames } from '../src/agents/run.ts'
import type { AgentPreset } from '../src/agents/types.ts'
import { readTool } from '../src/tools/builtin/read.ts'
import { writeTool } from '../src/tools/builtin/write.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

function preset(overrides: Partial<AgentPreset>): AgentPreset {
  return {
    id: 'test',
    description: 'test',
    models: [{ provider: 'p', model: 'm' }],
    tools: ['read', 'write', 'request_agent'],
    maxSteps: 3,
    timeoutMs: 10_000,
    readOnly: false,
    ...overrides,
  }
}

const tools = new ToolRegistry()
tools.register(readTool)
tools.register(writeTool)

test('只读预设看不到写工具', () => {
  assert.deepEqual(allowedToolNames(preset({ readOnly: true }), tools), ['read'])
})

test('非只读预设默认也看不到危险工具', () => {
  assert.deepEqual(allowedToolNames(preset({}), tools), ['read'])
})

test('显式信任后危险工具才可见', () => {
  assert.deepEqual(
    allowedToolNames(preset({ allowDangerousTools: true }), tools),
    ['read', 'write'],
  )
})

test('子 agent 永远看不到派活工具', () => {
  assert.equal(
    allowedToolNames(preset({ allowDangerousTools: true }), tools).includes('request_agent'),
    false,
  )
})
