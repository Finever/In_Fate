/**
 * App 配置：profile、providers、presets、patch；defaultModel 仅为旧配置兼容。
 *
 * patch 只改装配，不改契约；工具默认只读，危险工具要显式启用。
 *
 * @module if/app/config
 */

import type { AgentPoolConfig, AgentPreset } from '../agents/types.ts'
import type { CompactionConfig } from '../compaction/types.ts'
import type { Profile } from '../config/profile.ts'
import type { RiskLevel, RiskMode } from '../core/risk-guard.ts'
import type { ModelRetryPolicy } from '../model/retry.ts'
import type { ProviderConfig } from '../model/types.ts'
import type { OffloadConfig } from '../tools/offload.ts'

export interface RuntimePatch {
  readonly model?: {
    readonly retry?: ModelRetryPolicy
    readonly admission?: {
      readonly enabled?: boolean
      readonly maxConcurrentPerProvider?: number
      readonly queueLimit?: number
      readonly waitMs?: number
      readonly cooldownBaseMs?: number
      readonly cooldownMaxMs?: number
      readonly requestsPerMinute?: number
      readonly providers?: Readonly<Record<string, {
        readonly maxConcurrent?: number
        readonly requestsPerMinute?: number
      }>>
    }
  }
  readonly fs?: {
    /** false = 不注入沙箱（默认 true） */
    readonly enforce?: boolean
    /** 不配就用 cwd + memoryLogRoot + agentDir */
    readonly readRoots?: readonly string[]
    readonly writeRoots?: readonly string[]
  }
  readonly network?: {
    /** false = 不注入网络策略（默认 true） */
    readonly enforce?: boolean
    readonly allowPrivateNetwork?: boolean
    readonly allowHosts?: readonly string[]
    readonly denyHosts?: readonly string[]
    readonly maxRedirects?: number
  }
  /** 风险操作守卫：按命令/路径分级，默认只对 high 以上发问、critical 拒绝。 */
  readonly riskGuard?: {
    readonly enabled?: boolean
    readonly mode?: RiskMode
    readonly askLevel?: RiskLevel
    readonly denyLevel?: RiskLevel
  }
  /** false = 不记录进程内指标（默认 true） */
  readonly metrics?: boolean
  /** 用量账本：详细请求保留天数；0 = 永久保留。默认 1095（3 年）。 */
  readonly usage?: {
    readonly detailRetentionDays?: number
    /** 启动时执行一次聚合清理；默认开。 */
    readonly rollupOnStart?: boolean
  }
  /** 进程级 host 锁：一个 dataRoot 只允许一个 host，默认开 */
  readonly hostLease?: {
    readonly enabled?: boolean
    /** 不配就用 `<dataRoot>/locks` */
    readonly lockDir?: string
  }
  /** agent 主动创建会话的配额；不配用默认值 */
  readonly sessions?: {
    readonly maxTotal?: number
    readonly maxPerCreator?: number
    /** 启动时补跑未处理的 wake 消息；默认开 */
    readonly recoverInbox?: boolean
  }
  readonly memory?: {
    /** 写记忆后自动 git commit；默认开，但只在 memory root 是 git 仓库时生效 */
    readonly autoCommit?: boolean
  }
  readonly workspace?: {
    /** 不配就用 App 的 cwd */
    readonly id?: string
    readonly lease?: {
      readonly enabled?: boolean
      readonly pathTtlMs?: number
      readonly workspaceTtlMs?: number
      readonly waitMs?: number
      readonly renewMs?: number
      readonly maxQueue?: number
    }
  }
}

export interface PatchConfig {
  readonly tools?: {
    /** 危险工具必须显式列在这里才会启用 */
    readonly enabled?: readonly string[]
    /** 全局禁用名单；优先于 enabled。 */
    readonly disabled?: readonly string[]
    /** 全局审批模式覆盖；没写的工具用注册表默认。 */
    readonly approval?: Readonly<Record<string, 'auto' | 'required'>>
  }
  readonly agents?: Partial<AgentPoolConfig>
  readonly compaction?: Partial<CompactionConfig>
  readonly context?: { readonly maxBytes?: number }
  /** 工具结果写时卸载；阈值全在这里，不写死在代码里 */
  readonly offload?: Partial<OffloadConfig>
  /** 按 id 覆盖预设；null 表示删掉这个可选字段 */
  readonly presets?: Readonly<Record<string, Partial<AgentPreset> | null>>
  /** 插件 v0：默认只加载内置示例，dev 目录要显式开启。 */
  readonly plugins?: {
    /** 是否扫描 dataRoot/plugins；默认关，只给开发者。 */
    readonly dev?: boolean
    /** 不配就用 dataRoot/plugins。 */
    readonly dir?: string
  }
  /** 运行时策略：重试、文件/网络沙箱、指标 */
  readonly runtime?: RuntimePatch
}

export interface UpdateConfig {
  /** 更新清单地址；http(s)、file: 或本地路径。留空则只用本地更新包。 */
  readonly manifestUrl?: string
}

export interface AppConfig {
  readonly version?: number
  readonly profile: Profile
  readonly providers: readonly ProviderConfig[]
  readonly presets: readonly AgentPreset[]
  /** 旧版兼容字段；运行期不再使用，模型由每个 agent 自己配置。 */
  readonly defaultModel?: { readonly provider: string; readonly model: string }
  readonly patch?: PatchConfig
  readonly update?: UpdateConfig
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

  if (!Array.isArray(raw.providers)) {
    throw new ConfigError('providers', 'must be an array')
  }
  if (!Array.isArray(raw.presets)) {
    throw new ConfigError('presets', 'must be an array')
  }

  const defaultModel = raw.defaultModel
  if (defaultModel !== undefined
    && (!isRecord(defaultModel)
      || typeof defaultModel.provider !== 'string'
      || typeof defaultModel.model !== 'string')) {
    throw new ConfigError('defaultModel', 'needs provider and model strings when set')
  }

  if (raw.patch !== undefined && !isRecord(raw.patch)) {
    throw new ConfigError('patch', 'must be an object')
  }
  if (isRecord(raw.patch) && raw.patch.runtime !== undefined && !isRecord(raw.patch.runtime)) {
    throw new ConfigError('patch.runtime', 'must be an object')
  }
  if (isRecord(raw.patch) && isRecord(raw.patch.runtime)
    && raw.patch.runtime.riskGuard !== undefined) {
    const guard = raw.patch.runtime.riskGuard
    if (!isRecord(guard)) throw new ConfigError('patch.runtime.riskGuard', 'must be an object')
    if (guard.enabled !== undefined && typeof guard.enabled !== 'boolean') {
      throw new ConfigError('patch.runtime.riskGuard.enabled', 'must be a boolean')
    }
    if (guard.mode !== undefined && guard.mode !== 'ask' && guard.mode !== 'deny') {
      throw new ConfigError('patch.runtime.riskGuard.mode', 'must be "ask" or "deny"')
    }
    for (const key of ['askLevel', 'denyLevel'] as const) {
      const value = guard[key]
      if (value !== undefined && !['low', 'medium', 'high', 'critical'].includes(String(value))) {
        throw new ConfigError(`patch.runtime.riskGuard.${key}`, 'must be low/medium/high/critical')
      }
    }
  }
  if (isRecord(raw.patch) && isRecord(raw.patch.runtime)
    && raw.patch.runtime.usage !== undefined) {
    const usage = raw.patch.runtime.usage
    if (!isRecord(usage)) throw new ConfigError('patch.runtime.usage', 'must be an object')
    if (usage.detailRetentionDays !== undefined
      && (typeof usage.detailRetentionDays !== 'number'
        || !Number.isFinite(usage.detailRetentionDays)
        || usage.detailRetentionDays < 0)) {
      throw new ConfigError('patch.runtime.usage.detailRetentionDays', 'must be a number >= 0')
    }
    if (usage.rollupOnStart !== undefined && typeof usage.rollupOnStart !== 'boolean') {
      throw new ConfigError('patch.runtime.usage.rollupOnStart', 'must be a boolean')
    }
  }
  if (raw.update !== undefined) {
    if (!isRecord(raw.update)) throw new ConfigError('update', 'must be an object')
    if (raw.update.manifestUrl !== undefined && typeof raw.update.manifestUrl !== 'string') {
      throw new ConfigError('update.manifestUrl', 'must be a string')
    }
  }

  return raw as unknown as AppConfig
}
