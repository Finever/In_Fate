/**
 * 插件私有 KV。
 *
 * 一个插件一个 storage.json；不共享、不越界。
 * 写入是原子替换，大小有上限，坏了就备份后重置，不让宿主崩。
 *
 * @module if/plugins/storage
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { PluginStorage } from './types.ts'

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const FILE_VERSION = 1
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

interface StorageFile {
  version: number
  values: Record<string, unknown>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface FilePluginStorageOptions {
  readonly root: string
  readonly label: string
  readonly maxBytes?: number
}

export class FilePluginStorage implements PluginStorage {
  private readonly options: FilePluginStorageOptions
  private readonly file: string
  private readonly maxBytes: number
  private data: StorageFile = { version: FILE_VERSION, values: {} }
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(options: FilePluginStorageOptions) {
    this.options = options
    mkdirSync(options.root, { recursive: true })
    this.file = join(options.root, 'storage.json')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    await this.queue
    this.load()
    if (!Object.hasOwn(this.data.values, key)) return undefined
    return clone(this.data.values[key]) as T
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertKey(key)
    await this.enqueue(async () => {
      this.load()
      let serialized: string | undefined
      try {
        serialized = JSON.stringify(value)
      } catch (error) {
        throw new Error(`plugin storage value is not JSON serializable: ${String(error)}`)
      }
      if (serialized === undefined) {
        throw new Error('plugin storage value must not be undefined')
      }
      const next: StorageFile = {
        version: FILE_VERSION,
        values: { ...this.data.values, [key]: JSON.parse(serialized) },
      }
      const text = JSON.stringify(next, null, 2)
      if (Buffer.byteLength(text, 'utf8') > this.maxBytes) {
        throw new Error(`plugin storage exceeds ${this.maxBytes} bytes`)
      }
      const previous = this.data
      this.data = next
      try {
        this.save(text)
      } catch (error) {
        this.data = previous
        throw error
      }
    })
  }

  async delete(key: string): Promise<boolean> {
    this.assertKey(key)
    return this.enqueue(async () => {
      this.load()
      if (!Object.hasOwn(this.data.values, key)) return false
      const values = { ...this.data.values }
      delete values[key]
      const previous = this.data
      this.data = { version: FILE_VERSION, values }
      try {
        this.save(JSON.stringify(this.data, null, 2))
      } catch (error) {
        this.data = previous
        throw error
      }
      return true
    })
  }

  async keys(): Promise<string[]> {
    await this.queue
    this.load()
    return Object.keys(this.data.values).sort()
  }

  private assertKey(key: string): void {
    if (!KEY_PATTERN.test(key)) {
      throw new Error('plugin storage key must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('storage root must be an object')
      }
      const record = raw as { version?: unknown; values?: unknown }
      if (record.version !== FILE_VERSION
        || typeof record.values !== 'object'
        || record.values === null
        || Array.isArray(record.values)) {
        throw new Error('unsupported storage shape')
      }
      this.data = {
        version: FILE_VERSION,
        values: record.values as Record<string, unknown>,
      }
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        renameSync(this.file, backup)
      } catch {
        // 备份失败也不能让插件存储阻塞宿主；下一次写入会覆盖。
      }
      console.warn(`[plugin-storage] ${this.options.label}: ${String(error)}; reset`)
      this.data = { version: FILE_VERSION, values: {} }
    }
  }

  private save(text: string): void {
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, this.file)
  }
}
