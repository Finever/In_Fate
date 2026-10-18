/**
 * 记忆源：文件到角色的映射。
 *
 * SOUL / USER / FACT 只是当前的名字，不是系统的假设。换名字改配置，
 * 不改代码。读不到的文件跳过（Cherry 的规则：一个文件缺失不阻断整轮）。
 *
 * @module if/memory/sources
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type SourceLayer = 'stable' | 'dynamic' | 'ephemeral'

export interface MemorySource {
  /** 配置里的稳定 id，用于追溯与事件记录 */
  readonly id: string
  /** 绝对路径或相对 agentDir 的路径 */
  readonly path: string
  /** 角色：identity / user / fact / skill / log / 自定义 */
  readonly role: string
  readonly layer: SourceLayer
  /** 同层内越大越先 */
  readonly priority?: number
}

export interface SourceChunk {
  readonly id: string
  readonly role: string
  readonly layer: SourceLayer
  readonly priority: number
  readonly text: string
  readonly bytes: number
  readonly digest: string
}

/** 当前记忆库的默认配置。名字是历史遗留，随时可换。 */
export function defaultSources(agentDir: string): MemorySource[] {
  return [
    { id: 'identity', path: join(agentDir, 'SOUL.md'), role: 'identity', layer: 'stable', priority: 100 },
    { id: 'user', path: join(agentDir, 'USER.md'), role: 'user', layer: 'stable', priority: 90 },
    { id: 'fact', path: join(agentDir, 'memory', 'FACT.md'), role: 'fact', layer: 'stable', priority: 80 },
  ]
}

/** 从 JSON 读配置；路径里可用 {agentDir} 占位。 */
export function loadSources(path: string, agentDir: string): MemorySource[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    sources?: MemorySource[]
  }
  if (!Array.isArray(raw.sources)) throw new Error(`sources config has no sources: ${path}`)
  return raw.sources.map(source => ({
    ...source,
    path: source.path.replaceAll('{agentDir}', agentDir),
  }))
}

export function digest(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

export interface ReadSourcesOptions {
  readonly readFile?: (path: string) => string
}

/** 读源文件，产出带字节数与 digest 的块。缺文件跳过。 */
export function readSources(
  sources: readonly MemorySource[],
  options: ReadSourcesOptions = {},
): SourceChunk[] {
  const read = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const chunks: SourceChunk[] = []

  for (const source of sources) {
    let text: string
    try {
      text = read(source.path)
    } catch {
      continue // 缺文件或读不了：跳过，不阻断整轮
    }
    chunks.push({
      id: source.id,
      role: source.role,
      layer: source.layer,
      priority: source.priority ?? 0,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      digest: digest(text),
    })
  }

  return chunks.sort((a, b) => {
    if (a.layer !== b.layer) {
      const order: Record<string, number> = { stable: 0, dynamic: 1, ephemeral: 2 }
      return (order[a.layer] ?? 9) - (order[b.layer] ?? 9)
    }
    return b.priority - a.priority
  })
}
