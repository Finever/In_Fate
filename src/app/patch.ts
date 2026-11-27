import type { AgentPoolConfig, AgentPreset } from '../agents/types.ts'
import { DEFAULT_AGENT_POOL } from '../agents/types.ts'
import { DEFAULT_COMPACTION, type CompactionConfig } from '../compaction/types.ts'
import { DEFAULT_OFFLOAD, type OffloadConfig } from '../tools/offload.ts'
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

export function mergeOffload(patch: Partial<OffloadConfig> | undefined): OffloadConfig {
  return applyFields(DEFAULT_OFFLOAD, patch)
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
