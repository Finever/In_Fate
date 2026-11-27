import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Principal {
  readonly id: string
  readonly name?: string
}

export interface AgentPrincipal extends Principal {
  readonly role?: string
}

export interface MemoryProfileSettings {
  /** false = 完全不启用内置记忆库 */
  readonly enabled?: boolean
  /** false = 不写内部记忆 log */
  readonly log?: boolean
}

export interface Profile {
  /** 数据根：会话、归档状态都放这里 */
  readonly dataRoot: string
  /** 记忆库根；默认 `<dataRoot>/memory` */
  readonly memoryRoot?: string
  /** @deprecated 旧名，等价于 memoryRoot */
  readonly memoryLogRoot?: string
  /** 内置记忆库开关 */
  readonly memory?: MemoryProfileSettings
  /** IANA 时区名，渲染给模型看的时间用它 */
  readonly timeZone: string
  /** 身份文件所在目录（SOUL/USER/FACT 的根） */
  readonly agentDir?: string
  /** 主 agent 的 system 头 */
  readonly header?: string
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
