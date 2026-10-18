/**
 * 模型来源注册表。一个场景可以挂任意多个来源，代码不认具体厂商。
 *
 * @module if/model/registry
 */

import { readFileSync } from 'node:fs'
import type { EndpointConfig, ModelCard, ProviderConfig } from './types.ts'

const providers = new Map<string, ProviderConfig>()

export function registerProvider(config: ProviderConfig): void {
  if (providers.has(config.id)) throw new Error(`provider already registered: ${config.id}`)
  if (Object.keys(config.endpoints).length === 0) {
    throw new Error(`provider has no endpoints: ${config.id}`)
  }
  providers.set(config.id, config)
}

export function getProvider(id: string): ProviderConfig {
  const provider = providers.get(id)
  if (!provider) throw new Error(`unknown provider: ${id}`)
  return provider
}

export function listProviders(): readonly ProviderConfig[] {
  return [...providers.values()]
}

export interface ResolvedModel {
  readonly provider: ProviderConfig
  readonly model: ModelCard
  readonly endpoint: EndpointConfig
  readonly apiModelId: string
}

/** 找来源、找模型、选端点。三步都可预测，失败就报错，不猜。 */
export function resolveModel(
  providerId: string,
  modelId: string,
  apiFamily?: string,
): ResolvedModel {
  const provider = getProvider(providerId)
  const model = provider.models.find(item => item.id === modelId)
  if (!model) throw new Error(`unknown model: ${providerId}/${modelId}`)

  const family = apiFamily ?? provider.defaultChatEndpoint ?? 'openai-chat-completions'
  const endpoint = provider.endpoints[family]
  if (!endpoint) throw new Error(`provider ${providerId} has no endpoint: ${family}`)

  return {
    provider,
    model,
    endpoint,
    apiModelId: model.apiModelId ?? model.id,
  }
}

export interface RegistryFile {
  readonly version?: number
  readonly providers: readonly ProviderConfig[]
}

/** 从 JSON 加载来源清单；重复注册会报错，避免两份配置打架。 */
export function loadRegistry(path: string): readonly ProviderConfig[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as RegistryFile
  if (!Array.isArray(doc.providers)) throw new Error(`registry has no providers: ${path}`)
  for (const provider of doc.providers) {
    if (!providers.has(provider.id)) registerProvider(provider)
  }
  return doc.providers
}

/** 运行时取密钥：优先显式密钥，其次环境变量。 */
export function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv) return process.env[provider.apiKeyEnv]
  return undefined
}
