/**
 * 预设注册表：代码只给结构，具体模型与预设值由外部配置提供。
 *
 * @module if/agents/presets
 */

import { readFileSync } from 'node:fs'
import type { AgentPreset } from './types.ts'

export function validatePreset(preset: AgentPreset): void {
  if (!preset.id || !preset.description) {
    throw new Error('preset needs id and description')
  }
  if (!Array.isArray(preset.models) || preset.models.length === 0) {
    throw new Error(`preset ${preset.id} needs at least one model`)
  }
  if (!Array.isArray(preset.tools)) {
    throw new Error(`preset ${preset.id} needs a tools array`)
  }
  if (!Number.isFinite(preset.maxSteps) || preset.maxSteps <= 0) {
    throw new Error(`preset ${preset.id} needs a positive maxSteps`)
  }
  if (!Number.isFinite(preset.timeoutMs) || preset.timeoutMs <= 0) {
    throw new Error(`preset ${preset.id} needs a positive timeoutMs`)
  }
  if (preset.budget) {
    for (const [key, value] of Object.entries(preset.budget)) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`preset ${preset.id} budget.${key} must be positive`)
      }
    }
  }
}

export class PresetRegistry {
  private readonly presets = new Map<string, AgentPreset>()

  register(preset: AgentPreset): void {
    validatePreset(preset)
    if (this.presets.has(preset.id)) throw new Error(`preset already registered: ${preset.id}`)
    this.presets.set(preset.id, preset)
  }

  get(id: string): AgentPreset | undefined {
    return this.presets.get(id)
  }

  list(): readonly AgentPreset[] {
    return [...this.presets.values()]
  }

  /** 从 JSON 文件加载 `{ presets: [...] }`。 */
  load(path: string): void {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { presets?: AgentPreset[] }
    if (!Array.isArray(doc.presets)) throw new Error(`presets file has no presets: ${path}`)
    for (const preset of doc.presets) this.register(preset)
  }

  /** 给模型看的预设摘要。 */
  describe(): string {
    return this.list()
      .map(preset => {
        const models = preset.models.map(choice => `${choice.provider}/${choice.model}`).join(' → ')
        return `- ${preset.id}：${preset.description}（模型候选：${models}；工具：${preset.tools.join('、')}；最多 ${preset.maxSteps} 步）`
      })
      .join('\n')
  }
}
