/**
 * 配置补丁：只改装配值，不改契约。
 *
 * 规则小而明确：undefined 跳过、null 删除可选字段、其余整字段替换。
 * 数组不深合并——候选链、工具白名单的顺序本身就是语义。
 *
 * @module if/app/patch
 */

import type { AgentPoolConfig, AgentPreset } from '../agents/types.ts'
import { DEFAULT_AGENT_POOL } from '../agents/types.ts'
import { DEFAULT_COMPACTION, type CompactionConfig } from '../compaction/types.ts'
import type { AppConfig } from './config.ts'

function applyFields<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return { ...base }
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out as T
}

export function mergePool(patch: Partial<AgentPoolConfig> | undefined): AgentPoolConfig {
  return applyFields(DEFAULT_AGENT_POOL, patch)
}

export function mergeCompaction(patch: Partial<CompactionConfig> | undefined): CompactionConfig {
  return applyFields(DEFAULT_COMPACTION, patch)
}

/** 预设覆盖可以整体设为 null——用于删掉一个预设。 */
export function mergePreset(
  preset: AgentPreset,
  patch: Partial<AgentPreset> | null | undefined,
): AgentPreset | null {
  if (patch === null) return null
  return applyFields(preset, patch)
}

export function applyPatches(config: AppConfig): AppConfig {
  const patches = config.patch?.presets
  if (!patches) return config

  const presets: AgentPreset[] = []
  for (const preset of config.presets) {
    const patched = Object.prototype.hasOwnProperty.call(patches, preset.id)
      ? mergePreset(preset, patches[preset.id])
      : preset
    if (patched) presets.push(patched)
  }

  return { ...config, presets }
}
