import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Profile } from '../config/profile.ts'

export const MEMORY_LAYOUT_VERSION = 1

export interface MemoryLibraryMeta {
  readonly version: 1
  readonly layoutVersion: number
  readonly createdAt: string
}

export interface MemoryPaths {
  readonly root: string
  readonly detail: string
  readonly log: string
  readonly proposals: string
  readonly summaries: string
  readonly agents: string
  readonly state: string
  readonly meta: string
  readonly indexlist: string
}

/** `memoryRoot` 是主字段；`memoryLogRoot` 是旧名，保留兼容。 */
export function resolveMemoryRoot(profile: Profile): string | undefined {
  if (profile.memory?.enabled === false) return undefined
  return profile.memoryRoot ?? profile.memoryLogRoot ?? join(profile.dataRoot, 'memory')
}

export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    detail: join(root, 'detail'),
    log: join(root, 'log'),
    proposals: join(root, 'proposals'),
    summaries: join(root, 'summaries'),
    agents: join(root, 'agents'),
    state: join(root, '.state'),
    meta: join(root, 'meta.json'),
    indexlist: join(root, 'indexlist.json'),
  }
}

/** 首次打开时把目录骨架建好；已有文件一律不碰。 */
export function ensureMemoryLayout(root: string): MemoryPaths {
  const paths = memoryPaths(root)
  for (const dir of [
    paths.detail,
    paths.log,
    paths.proposals,
    paths.summaries,
    paths.agents,
    paths.state,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  if (!existsSync(paths.meta)) {
    const meta: MemoryLibraryMeta = {
      version: 1,
      layoutVersion: MEMORY_LAYOUT_VERSION,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  }
  return paths
}
