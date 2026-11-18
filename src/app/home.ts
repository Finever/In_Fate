/**
 * IF 的“家目录”解析。
 *
 * 安装版：启动器设置 IF_HOME（例如 %LOCALAPPDATA%/In_Fate）。
 * 便携版：启动器设置 IF_HOME=程序根目录，或 IF_PORTABLE=1 用 cwd。
 * 开发环境不设置时，沿用配置文件里的 dataRoot。
 *
 * @module if/app/home
 */

import { resolve } from 'node:path'

export function resolveIfHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.IF_HOME?.trim()
  if (explicit) return resolve(explicit)
  if (env.IF_PORTABLE === '1') return resolve(process.cwd())
  return undefined
}
