import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { validateConfig, type AppConfig } from './config.ts'

function absolute(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path)
}

function normalizeRuntime(
  patch: AppConfig['patch'],
  baseDir: string,
): AppConfig['patch'] {
  if (!patch?.runtime?.fs) return patch
  const fs = patch.runtime.fs
  return {
    ...patch,
    runtime: {
      ...patch.runtime,
      fs: {
        ...fs,
        ...(fs.readRoots ? { readRoots: fs.readRoots.map(root => absolute(baseDir, root)) } : {}),
        ...(fs.writeRoots ? { writeRoots: fs.writeRoots.map(root => absolute(baseDir, root)) } : {}),
      },
    },
  }
}

export function normalizePaths(config: AppConfig, baseDir: string): AppConfig {
  return {
    ...config,
    profile: {
      ...config.profile,
      dataRoot: absolute(baseDir, config.profile.dataRoot),
      ...(config.profile.memoryLogRoot
        ? { memoryLogRoot: absolute(baseDir, config.profile.memoryLogRoot) }
        : {}),
      ...(config.profile.agentDir
        ? { agentDir: absolute(baseDir, config.profile.agentDir) }
        : {}),
    },
    ...(config.patch ? { patch: normalizeRuntime(config.patch, baseDir) } : {}),
  }
}

export function loadConfig(path: string): AppConfig {
  const file = resolve(path)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  return normalizePaths(validateConfig(raw), dirname(file))
}
