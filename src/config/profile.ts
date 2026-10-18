/**
 * Profile：一个场景的全部可变设定。
 *
 * 路径、时区、参与者都从这里来；核心代码不许写死任何一项。
 *
 * @module if/config/profile
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Principal {
  readonly id: string
  readonly name?: string
}

export interface AgentPrincipal extends Principal {
  readonly role?: string
}

export interface Profile {
  /** 数据根：会话、归档状态都放这里 */
  readonly dataRoot: string
  /** 记忆库 log 的根；不配就不归档 */
  readonly memoryLogRoot?: string
  /** IANA 时区名，渲染给模型看的时间用它 */
  readonly timeZone: string
  /** 这个场景里有哪些人 */
  readonly principals: {
    readonly user?: Principal
    readonly agents?: readonly AgentPrincipal[]
  }
}

/** 开发用的默认值。真实场景应当从 profile 文件加载。 */
export function defaultProfile(cwd: string = process.cwd()): Profile {
  return {
    dataRoot: join(cwd, 'data'),
    timeZone: 'Asia/Shanghai',
    principals: {},
  }
}

/** 读 profile 文件；缺的字段退回默认值，不做隐式猜测。 */
export function loadProfile(path: string, cwd: string = process.cwd()): Profile {
  const base = defaultProfile(cwd)
  if (!existsSync(path)) throw new Error(`profile not found: ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Profile>
  return {
    ...base,
    ...raw,
    principals: raw.principals ?? base.principals,
  }
}
