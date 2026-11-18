/**
 * IF 的“家目录”解析。IF_HOME 指向数据根（In_First/data），不再拼子目录。
 *
 * 便携包：In_First/In_Fate 是程序，In_First/data 是数据；
 * 启动器设置 IF_HOME=<包根>/data，或 IF_PORTABLE=1 用 cwd/data。
 * 安装版：同样结构，默认根在 %USERPROFILE%/In_First。
 * 开发环境不设置时，沿用配置文件里的 dataRoot。
 *
 * @module if/app/home
 */

import { resolve } from 'node:path'

export function resolveIfHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.IF_HOME?.trim()
  if (explicit) return resolve(explicit)
  if (env.IF_PORTABLE === '1') return resolve(process.cwd(), 'data')
  return undefined
}
