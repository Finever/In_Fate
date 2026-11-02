import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 给执行真实主对话的测试写一份最小 agent 设置。 */
export function seedAgentModel(
  dataRoot: string,
  options: { provider?: string; model?: string; agentId?: string } = {},
): void {
  const agentId = options.agentId ?? 'main'
  const provider = options.provider ?? 'fake'
  const model = options.model ?? 'm'
  const dir = join(dataRoot, 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({
    version: 1,
    agentId,
    models: {
      main: { provider, model },
      subagents: [{ provider, model }],
    },
  }, null, 2)}\n`, 'utf8')
}
