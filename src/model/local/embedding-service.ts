/**
 * 本地 embedding 推理：没装模型就报错，装了才加载 llama.cpp。
 *
 * @module if/model/local/embedding-service
 */

import type { Llama, LlamaEmbeddingContext, LlamaModel } from 'node-llama-cpp'
import { embeddingModelPreset } from './embedding-models.ts'
import { LocalEmbeddingStore } from './embedding-store.ts'

export interface LocalEmbeddingOptions {
  readonly gpu?: 'auto' | false
  readonly threads?: number
}

export class LocalEmbeddingService {
  readonly store: LocalEmbeddingStore
  private readonly options: LocalEmbeddingOptions
  private llama?: Llama
  private model?: LlamaModel
  private context?: LlamaEmbeddingContext
  private loadedId?: string

  constructor(store: LocalEmbeddingStore, options: LocalEmbeddingOptions = {}) {
    this.store = store
    this.options = options
  }

  isAvailable(): boolean {
    return Boolean(this.store.active())
  }

  modelId(): string | undefined {
    return this.store.active()?.id
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const active = this.store.active()
    if (!active) throw new Error('embedding model is not installed/activated')
    const preset = embeddingModelPreset(active.id)
    return this.embed(`${preset.queryPrefix}${text}`)
  }

  async embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text)
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (const text of texts) out.push(await this.embedDocument(text))
    return out
  }

  async dispose(): Promise<void> {
    await this.context?.dispose()
    await this.model?.dispose()
    await this.llama?.dispose()
    this.context = undefined
    this.model = undefined
    this.llama = undefined
    this.loadedId = undefined
  }

  private async embed(text: string): Promise<Float32Array> {
    const context = await this.load()
    const embedding = await context.getEmbeddingFor(text)
    return normalize(embedding.vector)
  }

  private async load(): Promise<LlamaEmbeddingContext> {
    const active = this.store.active()
    if (!active) throw new Error('embedding model is not installed/activated')
    if (this.context && this.loadedId === active.id) return this.context

    await this.dispose()
    this.loadedId = active.id
    const { getLlama } = await import('node-llama-cpp')
    this.llama = await getLlama({
      gpu: this.options.gpu === undefined ? 'auto' : this.options.gpu,
    })
    this.model = await this.llama.loadModel({ modelPath: active.path })
    this.context = await this.model.createEmbeddingContext({
      contextSize: Math.min(active.contextSize, 4096),
      ...(this.options.threads ? { threads: this.options.threads } : {}),
    })
    return this.context
  }
}

function normalize(vector: readonly number[]): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum) || 1
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / length
  return out
}
