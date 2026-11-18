/**
 * 启动：读配置 → 归一路径 → 装配。任何一步失败都回滚已建资源。
 *
 * 错误分三类，方便 CLI 给出不同提示：
 *   config      配置本身不合法
 *   dependency  配置合法，但引用的模型/预设/端点不存在
 *   environment 文件系统、权限、网络等外部条件
 *
 * @module if/app/bootstrap
 */

import { resolve } from 'node:path'
import { ConfigError, type AppConfig } from './config.ts'
import { buildBundle, type App, type BuildOptions } from './bundle.ts'
import { Container } from './container.ts'
import { ensureDataSchema } from './data-schema.ts'
import { resolveIfHome } from './home.ts'
import { loadConfig, normalizePaths } from './load.ts'
import { IF_VERSION } from '../version.ts'

export type ErrorKind = 'config' | 'dependency' | 'environment'

export function classifyError(error: unknown): ErrorKind {
  if (error instanceof ConfigError) return 'config'
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^(EACCES|EPERM|ENOENT|ENOSPC|EEXIST|EMFILE|EHOSTBUSY)$/.test(code)) {
    return 'environment'
  }
  if (error instanceof SyntaxError) return 'config'
  return 'dependency'
}

export interface BootstrapOptions extends BuildOptions {
  /** 配置文件路径；不传读 IF_CONFIG，再退回 config/if.json */
  readonly configPath?: string
  /** 直接给已解析的配置（测试用） */
  readonly config?: AppConfig
  /** 相对路径的基准目录；默认当前目录 */
  readonly baseDir?: string
}

export function defaultConfigPath(): string {
  return process.env.IF_CONFIG ?? 'config/if.json'
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<App> {
  const configPath = options.configPath
    ?? (options.config ? undefined : defaultConfigPath())
  const config = options.config ?? loadConfig(configPath!)
  // loadConfig 已按配置文件目录解析；这里再解析一次只影响直接传入的相对路径。
  const normalized = normalizePaths(config, options.baseDir ?? process.cwd())
  const home = resolveIfHome()
  const homed = home
    ? {
      ...normalized,
      profile: {
        ...normalized.profile,
        dataRoot: home,
      },
    }
    : normalized
  await ensureDataSchema(homed.profile.dataRoot, IF_VERSION)

  const container = new Container()
  try {
    return buildBundle(homed, container, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(configPath ? { configPath: resolve(configPath) } : {}),
    })
  } catch (error) {
    await container.dispose()
    throw error
  }
}
