/**
 * 配置加载：以配置文件所在目录为路径基准，解析一次就存绝对路径。
 *
 * @module if/app/load
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { validateConfig, type AppConfig } from './config.ts'

function absolute(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path)
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
  }
}

export function loadConfig(path: string): AppConfig {
  const file = resolve(path)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  return normalizePaths(validateConfig(raw), dirname(file))
}
