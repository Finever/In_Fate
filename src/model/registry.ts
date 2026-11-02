/**
 * 模型来源注册表。实例级，避免两个 App 互相污染。
 * 旧的模块级函数保留，内部走一个默认实例，兼容现有 demo。
 *
 * @module if/model/registry
 */

import { readFileSync } from 'node:fs'
import type { EndpointConfig, ModelCard, ProviderConfig } from './types.ts'

export interface ResolvedModel {
  readonly provider: ProviderConfig
  readonly model: ModelCard
  readonly endpoint: EndpointConfig
  readonly apiModelId: string
  /** 解析时选的端点格式；适配器按它分发 */
  readonly family?: string
}

export class ModelRegistry {
  private readonly providers = new Map<string, ProviderConfig>()

  register(config: ProviderConfig): void {
    if (this.providers.has(config.id)) throw new Error(`provider already registered: ${config.id}`)
    if (Object.keys(config.endpoints).length === 0) {
      throw new Error(`provider has no endpoints: ${config.id}`)
    }
    this.providers.set(config.id, config)
  }

  get(id: string): ProviderConfig {
    const provider = this.providers.get(id)
    if (!provider) throw new Error(`unknown provider: ${id}`)
    return provider
  }

  list(): readonly ProviderConfig[] {
    return [...this.providers.values()]
  }

  /** 移除 provider（只用于用户自建的；内置在 App 层拦住）。 */
  remove(id: string): void {
    this.providers.delete(id)
  }

  setEnabled(id: string, enabled: boolean): void {
    const provider = this.get(id)
    this.providers.set(id, { ...provider, enabled })
  }

  setModelEnabled(id: string, modelId: string, enabled: boolean): void {
    const provider = this.get(id)
    this.providers.set(id, {
      ...provider,
      models: provider.models.map(model =>
        model.id === modelId ? { ...model, enabled } : model),
    })
  }

  setApiKeys(id: string, apiKeys: ProviderConfig['apiKeys']): void {
    const provider = this.get(id)
    if (apiKeys?.length) {
      this.providers.set(id, { ...provider, apiKeys })
      return
    }
    const { apiKeys: _removed, ...rest } = provider
    this.providers.set(id, rest)
  }

  /** 给已有 provider 追加模型；重复 id 跳过。 */
  addModels(id: string, models: readonly ModelCard[]): void {
    const provider = this.get(id)
    const seen = new Set(provider.models.map(model => model.id))
    const merged = [...provider.models]
    for (const model of models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      merged.push(model)
    }
    this.providers.set(id, { ...provider, models: merged })
  }

  resolve(providerId: string, modelId: string, apiFamily?: string): ResolvedModel {
    const provider = this.get(providerId)
    if (provider.enabled === false) throw new Error(`provider is disabled: ${providerId}`)
    const model = provider.models.find(item => item.id === modelId)
    if (!model) throw new Error(`unknown model: ${providerId}/${modelId}`)
    if (model.enabled === false) throw new Error(`model is disabled: ${providerId}/${modelId}`)

    const family = apiFamily ?? provider.defaultChatEndpoint ?? 'openai-chat-completions'
    const endpoint = provider.endpoints[family]
    if (!endpoint) throw new Error(`provider ${providerId} has no endpoint: ${family}`)

    return {
      provider,
      model,
      endpoint,
      apiModelId: model.apiModelId ?? model.id,
      family,
    }
  }

  /** 启用中的多密钥 → 旧单密钥 → 环境变量；去重、去空。 */
  resolveApiKeys(provider: ProviderConfig): string[] {
    const keys: string[] = []
    for (const entry of provider.apiKeys ?? []) {
      if (entry.isEnabled === false) continue
      if (typeof entry.key !== 'string' || entry.key.trim().length === 0) continue
      keys.push(entry.key.trim())
    }
    if (typeof provider.apiKey === 'string' && provider.apiKey.trim()) {
      keys.push(provider.apiKey.trim())
    }
    const env = provider.apiKeyEnv ? process.env[provider.apiKeyEnv]?.trim() : undefined
    if (env) keys.push(env)
    return [...new Set(keys)]
  }

  resolveApiKey(provider: ProviderConfig): string | undefined {
    return this.resolveApiKeys(provider)[0]
  }

  load(path: string): readonly ProviderConfig[] {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      providers?: readonly ProviderConfig[]
    }
    if (!Array.isArray(doc.providers)) throw new Error(`registry has no providers: ${path}`)
    for (const provider of doc.providers) {
      if (!this.providers.has(provider.id)) this.register(provider)
    }
    return doc.providers
  }
}

const defaultRegistry = new ModelRegistry()

export function registerProvider(config: ProviderConfig): void {
  defaultRegistry.register(config)
}

export function getProvider(id: string): ProviderConfig {
  return defaultRegistry.get(id)
}

export function listProviders(): readonly ProviderConfig[] {
  return defaultRegistry.list()
}

export function resolveModel(providerId: string, modelId: string, apiFamily?: string): ResolvedModel {
  return defaultRegistry.resolve(providerId, modelId, apiFamily)
}

export function resolveApiKey(provider: ProviderConfig): string | undefined {
  return defaultRegistry.resolveApiKey(provider)
}

export function resolveApiKeys(provider: ProviderConfig): string[] {
  return defaultRegistry.resolveApiKeys(provider)
}

export function loadRegistry(path: string): readonly ProviderConfig[] {
  return defaultRegistry.load(path)
}
