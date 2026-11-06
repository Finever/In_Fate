/**
 * 可一键安装的本地 embedding 模型清单。
 *
 * 权重不进仓库；这里只放仓库、文件、大小、sha256 和提示前缀。
 *
 * @module if/model/local/embedding-models
 */

export interface EmbeddingModelPreset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly repo: string
  readonly file: string
  readonly size: number
  /** HuggingFace LFS oid 就是 sha256 */
  readonly sha256: string
  readonly dimensions: number
  readonly contextSize: number
  readonly license: string
  readonly quantization: string
  /** 检索 query 需要加的前缀；文档不加 */
  readonly queryPrefix: string
}

export const EMBEDDING_MODEL_PRESETS: readonly EmbeddingModelPreset[] = [
  {
    id: 'bge-base-zh-v1.5',
    name: 'BGE-base 中文',
    description: '轻量、CPU 友好，适合作为默认中文检索',
    repo: 'CompendiumLabs/bge-base-zh-v1.5-gguf',
    file: 'bge-base-zh-v1.5-q8_0.gguf',
    size: 110_001_568,
    sha256: '893a0f07100c135b35196fc95058f5933c3435905b167ac29c58d77d7cef4be7',
    dimensions: 768,
    contextSize: 512,
    license: 'MIT',
    quantization: 'Q8_0',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
  },
  {
    id: 'qwen3-embedding-0.6b',
    name: 'Qwen3-Embedding 0.6B',
    description: '中文检索质量优先，CPU 可用但比 BGE-base 重',
    repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    size: 639_150_592,
    sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
    dimensions: 1024,
    contextSize: 32_768,
    license: 'Apache-2.0',
    quantization: 'Q8_0',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
  },
]

export function embeddingModelPreset(id: string): EmbeddingModelPreset {
  const preset = EMBEDDING_MODEL_PRESETS.find(item => item.id === id)
  if (!preset) throw new Error(`unknown embedding model: ${id}`)
  return preset
}

export function embeddingDownloadUrl(
  preset: EmbeddingModelPreset,
  mirror = false,
): string {
  const base = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co'
  return `${base}/${preset.repo}/resolve/main/${preset.file}?download=true`
}
