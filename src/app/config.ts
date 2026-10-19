/**
 * App 配置：profile、providers、presets、defaultModel、patch。
 *
 * patch 只改装配，不改契约；工具默认只读，危险工具要显式启用。
 *
 * @module if/app/config
 */

import type { AgentPoolConfig, AgentPreset } from '../agents/types.ts'
import type { CompactionConfig } from '../compaction/types.ts'
import type { Profile } from '../config/profile.ts'
import type { ProviderConfig } from '../model/types.ts'

export interface PatchConfig {
  readonly tools?: {
    /** 危险工具必须显式列在这里才会注册 */
    readonly enabled?: readonly string[]
  }
  readonly agents?: Partial<AgentPoolConfig>
  readonly compaction?: Partial<CompactionConfig>
  readonly context?: { readonly maxBytes?: number }
  /** 按 id 覆盖预设；null 表示删掉这个可选字段 */
  readonly presets?: Readonly<Record<string, Partial<AgentPreset> | null>>
}

export interface AppConfig {
  readonly version?: number
  readonly profile: Profile
  readonly providers: readonly ProviderConfig[]
  readonly presets: readonly AgentPreset[]
  readonly defaultModel: { readonly provider: string; readonly model: string }
  readonly patch?: PatchConfig
}

export class ConfigError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ConfigError'
    this.path = path
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 浅校验：深度规则交给各注册表。 */
export function validateConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) throw new ConfigError('$', 'config must be an object')

  const profile = raw.profile
  if (!isRecord(profile)) throw new ConfigError('profile', 'missing or not an object')
  if (typeof profile.dataRoot !== 'string' || profile.dataRoot.length === 0) {
    throw new ConfigError('profile.dataRoot', 'must be a non-empty string')
  }
  if (typeof profile.timeZone !== 'string' || profile.timeZone.length === 0) {
    throw new ConfigError('profile.timeZone', 'must be a non-empty string')
  }

  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new ConfigError('providers', 'must be a non-empty array')
  }
  if (!Array.isArray(raw.presets)) {
    throw new ConfigError('presets', 'must be an array')
  }

  const defaultModel = raw.defaultModel
  if (!isRecord(defaultModel)
    || typeof defaultModel.provider !== 'string'
    || typeof defaultModel.model !== 'string') {
    throw new ConfigError('defaultModel', 'needs provider and model strings')
  }

  if (raw.patch !== undefined && !isRecord(raw.patch)) {
    throw new ConfigError('patch', 'must be an object')
  }

  return raw as unknown as AppConfig
}
