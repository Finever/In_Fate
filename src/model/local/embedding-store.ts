/**
 * 本地 embedding 模型安装器：下载、校验、激活、删除。
 *
 * 权重放 `<dataRoot>/models/embeddings/<id>/`，不进仓库，也不进记忆库 git。
 *
 * @module if/model/local/embedding-store
 */

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  EMBEDDING_MODEL_PRESETS,
  embeddingDownloadUrl,
  type EmbeddingModelPreset,
} from './embedding-models.ts'

export interface EmbeddingModelManifest {
  readonly id: string
  readonly repo: string
  readonly file: string
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly dimensions: number
  readonly contextSize: number
  readonly license: string
  readonly quantization: string
  readonly installedAt: string
}

export interface EmbeddingModelStatus {
  readonly preset: EmbeddingModelPreset
  readonly installed: boolean
  readonly active: boolean
  readonly manifest?: EmbeddingModelManifest
  readonly totalBytes: number
}

export interface EmbeddingInstallProgress {
  readonly id: string
  readonly received: number
  readonly total: number
  readonly ratio: number
}

export interface EmbeddingInstallOptions {
  readonly mirror?: boolean
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: EmbeddingInstallProgress) => void
}

export interface EmbeddingStoreOptions {
  readonly presets?: readonly EmbeddingModelPreset[]
  readonly fetchImpl?: typeof fetch
}

interface ActiveConfig {
  readonly activeId?: string
  readonly updatedAt?: string
}

export class LocalEmbeddingStore {
  readonly root: string
  private readonly presets: readonly EmbeddingModelPreset[]
  private readonly fetchImpl: typeof fetch
  private readonly activePath: string

  constructor(root: string, options: EmbeddingStoreOptions = {}) {
    this.root = root
    this.presets = options.presets ?? EMBEDDING_MODEL_PRESETS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.activePath = join(root, 'active.json')
  }

  list(): EmbeddingModelStatus[] {
    const activeId = this.activeConfig().activeId
    return this.presets.map(preset => {
      const manifest = this.readManifest(preset.id)
      const installed = Boolean(
        manifest
        && existsSync(manifest.path)
        && statSync(manifest.path).size === manifest.size,
      )
      return {
        preset,
        installed,
        active: installed && activeId === preset.id,
        ...(manifest ? { manifest } : {}),
        totalBytes: preset.size,
      }
    })
  }

  status(id: string): EmbeddingModelStatus {
    const preset = this.preset(id)
    return this.list().find(item => item.preset.id === preset.id)!
  }

  active(): EmbeddingModelManifest | undefined {
    const id = this.activeConfig().activeId
    if (!id) return undefined
    const manifest = this.readManifest(id)
    if (!manifest || !existsSync(manifest.path)) return undefined
    return manifest
  }

  modelPath(id: string): string {
    return join(this.root, id, this.preset(id).file)
  }

  async install(id: string, options: EmbeddingInstallOptions = {}): Promise<EmbeddingModelManifest> {
    const preset = this.preset(id)
    const dir = join(this.root, id)
    const partPath = `${this.modelPath(id)}.part`
    const finalPath = this.modelPath(id)
    mkdirSync(dir, { recursive: true })

    const existing = this.readManifest(id)
    if (
      existing
      && existsSync(existing.path)
      && statSync(existing.path).size === existing.size
    ) {
      return existing
    }

    // 国内网络默认先走镜像；失败再回源。两边都保留断点续传。
    const mirrorFirst = options.mirror ?? true
    const sources = mirrorFirst
      ? [embeddingDownloadUrl(preset, true), embeddingDownloadUrl(preset, false)]
      : [embeddingDownloadUrl(preset, false), embeddingDownloadUrl(preset, true)]

    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason
      const url = sources[attempt % sources.length]!
      try {
        await this.downloadPart(preset, partPath, url, options)
        const digest = await hashFile(partPath)
        if (digest !== preset.sha256) {
          rmSync(partPath, { force: true })
          throw new Error(`sha256 mismatch: ${digest} vs ${preset.sha256}`)
        }
        if (statSync(partPath).size !== preset.size) {
          rmSync(partPath, { force: true })
          throw new Error(`download size mismatch: ${statSync(partPath).size} vs ${preset.size}`)
        }

        renameSync(partPath, finalPath)
        const manifest: EmbeddingModelManifest = {
          id: preset.id,
          repo: preset.repo,
          file: preset.file,
          path: finalPath,
          size: preset.size,
          sha256: preset.sha256,
          dimensions: preset.dimensions,
          contextSize: preset.contextSize,
          license: preset.license,
          quantization: preset.quantization,
          installedAt: new Date().toISOString(),
        }
        this.writeManifest(manifest)
        return manifest
      } catch (error) {
        lastError = error
        if (options.signal?.aborted) throw error
        // 校验失败说明内容已经不对，重试同一份 .part 没意义。
        if (/sha256 mismatch/.test(String(error))) throw error
        if (attempt < 4) {
          await delay(500 * 2 ** attempt, options.signal)
        }
      }
    }
    throw lastError
  }

  private async downloadPart(
    preset: EmbeddingModelPreset,
    partPath: string,
    url: string,
    options: EmbeddingInstallOptions,
  ): Promise<void> {
    let existing = existsSync(partPath) ? statSync(partPath).size : 0
    if (existing > preset.size) {
      rmSync(partPath, { force: true })
      existing = 0
    }
    if (existing === preset.size) {
      options.onProgress?.({ id: preset.id, received: existing, total: preset.size, ratio: 1 })
      return
    }

    const response = await this.fetchImpl(url, {
      ...(options.signal ? { signal: options.signal } : {}),
      headers: {
        accept: 'application/octet-stream',
        ...(existing > 0 ? { range: `bytes=${existing}-` } : {}),
      },
    })
    if (response.status === 416 && existing === preset.size) {
      // 上次其实已经下完，只是没来得及改名/校验。
      return
    }
    if (!response.ok) {
      throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`)
    }
    if (!response.body) throw new Error('download failed: no response body')

    let resume = existing > 0 && response.status === 206
    if (existing > 0 && !resume) {
      // 服务端不支持 Range：从头来，别把新字节接在旧文件后面。
      existing = 0
      rmSync(partPath, { force: true })
    }

    const out = createWriteStream(partPath, { flags: existing > 0 ? 'a' : 'w' })
    const reader = response.body.getReader()
    let received = existing
    let lastReport = 0
    const report = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastReport < 150) return
      lastReport = now
      options.onProgress?.({
        id: preset.id,
        received,
        total: preset.size,
        ratio: preset.size > 0 ? received / preset.size : 0,
      })
    }
    report(true)

    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        const buffer = Buffer.from(chunk.value)
        received += buffer.byteLength
        if (!out.write(buffer)) await once(out, 'drain')
        report()
      }
      await new Promise<void>((resolve, reject) => {
        out.end((error?: Error | null) => error ? reject(error) : resolve())
      })
      report(true)
      if (received !== preset.size) {
        throw new Error(`download size mismatch: ${received} vs ${preset.size}`)
      }
    } catch (error) {
      out.destroy()
      try {
        await reader.cancel()
      } catch {
        // 已经结束
      }
      throw error
    }
  }

  activate(id: string): EmbeddingModelStatus {
    const manifest = this.readManifest(id)
    if (!manifest || !existsSync(manifest.path)) {
      throw new Error(`embedding model is not installed: ${id}`)
    }
    mkdirSync(this.root, { recursive: true })
    const config: ActiveConfig = {
      activeId: id,
      updatedAt: new Date().toISOString(),
    }
    const temp = `${this.activePath}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameSync(temp, this.activePath)
    return this.status(id)
  }

  remove(id: string): void {
    const preset = this.preset(id)
    rmSync(join(this.root, preset.id), { recursive: true, force: true })
    if (this.activeConfig().activeId === id) {
      rmSync(this.activePath, { force: true })
    }
  }

  private preset(id: string): EmbeddingModelPreset {
    const preset = this.presets.find(item => item.id === id)
    if (!preset) throw new Error(`unknown embedding model: ${id}`)
    return preset
  }

  private manifestPath(id: string): string {
    return join(this.root, id, 'manifest.json')
  }

  private readManifest(id: string): EmbeddingModelManifest | undefined {
    const path = this.manifestPath(id)
    if (!existsSync(path)) return undefined
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as EmbeddingModelManifest
      if (raw.id !== id || typeof raw.path !== 'string') return undefined
      return raw
    } catch {
      return undefined
    }
  }

  private writeManifest(manifest: EmbeddingModelManifest): void {
    const path = this.manifestPath(manifest.id)
    mkdirSync(join(this.root, manifest.id), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  }

  private activeConfig(): ActiveConfig {
    if (!existsSync(this.activePath)) return {}
    try {
      return JSON.parse(readFileSync(this.activePath, 'utf8')) as ActiveConfig
    } catch {
      return {}
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
