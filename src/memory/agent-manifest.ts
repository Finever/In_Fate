/**
 * Agent manifest：`<memoryRoot>/agents/<agentId>/agent.json`。
 *
 * 身份槽位 id 稳定；label 是给 UI/模型看的名字，file 是 identity 目录里的
 * 文件名。默认三段是 Principle / Preference / Prompt；旧 SOUL/USER/FACT 只是
 * legacy 来源，不是系统假设。
 *
 * @module if/memory/agent-manifest
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from '../core/lock.ts'
import { assertWithin } from '../core/safe-path.ts'

export type IdentitySourceLayer = 'stable' | 'dynamic' | 'ephemeral'
export type IdentitySlotName = 'principle' | 'preference' | 'prompt'

export interface IdentitySlot {
  /** 稳定 id，例如 principle / preference / prompt；UI 不直接改 */
  readonly id: string
  /** 显示名，例如 本心 / 所爱 / 提示 */
  readonly label: string
  /** identity 目录里的文件名 */
  readonly file: string
  /** 越大越先进入上下文 */
  readonly order: number
  /** 给 UI/模型看的边界说明 */
  readonly description?: string
  /** 记忆源角色，默认 identity */
  readonly role?: string
  readonly layer?: IdentitySourceLayer
  readonly priority?: number
}

export interface AgentManifest {
  readonly version: 1
  readonly id: string
  readonly name: string
  readonly identity: readonly IdentitySlot[]
}

const BAD_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/
const SLOT_ID = /^[a-z][a-z0-9_-]*$/

function assertSegment(value: string, label: string): string {
  if (typeof value !== 'string' || (
    value.length === 0
    || value === '.'
    || value === '..'
    || value === '.trash'
    || BAD_SEGMENT.test(value)
    || /[. ]$/.test(value)
  )) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

function assertFile(value: string): string {
  assertSegment(value, 'identity file')
  if (!value.endsWith('.md')) throw new Error(`identity file must end with .md: ${value}`)
  return value
}

export function validateAgentManifest(manifest: AgentManifest): AgentManifest {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('agent manifest must be an object')
  if (manifest.version !== 1) throw new Error(`unsupported agent manifest version: ${String(manifest.version)}`)
  assertSegment(manifest.id, 'agent id')
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new Error('agent manifest needs a name')
  }
  if (!Array.isArray(manifest.identity) || manifest.identity.length === 0) {
    throw new Error('agent manifest needs at least one identity slot')
  }

  const ids = new Set<string>()
  const files = new Set<string>()
  for (const slot of manifest.identity) {
    if (!SLOT_ID.test(slot.id)) {
      throw new Error(`invalid identity slot id: ${JSON.stringify(slot.id)}`)
    }
    if (ids.has(slot.id)) throw new Error(`duplicate identity slot id: ${slot.id}`)
    ids.add(slot.id)

    if (typeof slot.label !== 'string' || slot.label.trim().length === 0 || slot.label.includes('\n')) {
      throw new Error(`invalid identity slot label: ${JSON.stringify(slot.label)}`)
    }
    if (slot.label.length > 80) throw new Error(`identity slot label too long: ${slot.label}`)
    if (slot.description !== undefined && (typeof slot.description !== 'string' || slot.description.trim().length === 0)) {
      throw new Error(`invalid identity slot description: ${String(slot.description)}`)
    }
    assertFile(slot.file)
    if (files.has(slot.file)) throw new Error(`duplicate identity file: ${slot.file}`)
    files.add(slot.file)
    if (!Number.isFinite(slot.order)) throw new Error(`invalid identity slot order: ${String(slot.order)}`)
  }

  return manifest
}

export function defaultIdentitySlots(
  labels: Partial<Record<IdentitySlotName, string>> = {},
): IdentitySlot[] {
  return [
    {
      id: 'principle',
      label: labels.principle ?? '原则',
      file: 'principle.md',
      order: 100,
      role: 'identity',
      layer: 'stable',
      description: '本心、原则、边界、说话方式',
    },
    {
      id: 'preference',
      label: labels.preference ?? '偏好',
      file: 'preference.md',
      order: 90,
      role: 'user',
      layer: 'stable',
      description: '我与你各自的偏好、习惯、画像',
    },
    {
      id: 'prompt',
      label: labels.prompt ?? '提示',
      file: 'prompt.md',
      order: 80,
      role: 'fact',
      layer: 'stable',
      description: '环境与记忆系统的稳定说明；末尾接续点',
    },
  ]
}

export function defaultAgentManifest(
  agentId: string,
  name = agentId,
  labels: Partial<Record<IdentitySlotName, string>> = {},
): AgentManifest {
  return validateAgentManifest({
    version: 1,
    id: agentId,
    name,
    identity: defaultIdentitySlots(labels),
  })
}

const IDENTITY_HINTS: Record<string, string> = {
  principle: '原则。这里告诉我我是谁，描绘我的底色、准则、红线。',
  preference: '偏好。这里写用户与我的喜恶、习惯，我的思维与说话方式。',
  prompt: '提示。这里写当前的环境、工作目录、记忆系统的使用方式，接续点等。',
}

const PROMPT_DEFAULT = [
  '## IF 环境',
  '',
  '- 我运行在 In_Fate：一个本地桌面应用，Electron 外壳 + React 界面；对话与会话数据留在本机。',
  '- 会话以 JSONL 事件流保存；一轮从用户消息开始，到本轮完成结束。界面看到的是事件投影，不直接改写历史。',
  '- 可用工具分两类：read / recall / fetch / websearch 默认只读；write / edit / bash 需要显式开启，危险工具会走审批。',
  '- 主 agent 的身份由 agents/<agent-id>/agent.json 和 identity/ 下的三份 人格文件 文件定义。会话带 agentId，切 agent 就是切身份。',
  '',
  '## 记忆系统',
  '',
  '- 记忆库根目录：<memory-root>。下面提到的路径都相对它。',
  '- detail/<域>/<文件>.json 是分条记忆；每条有 id、rec-time、rev-time、at、tag 和 content，原话放 quotes。',
  '- tag 分三档：确信、可信、有疑。拿不准就往下调一档。',
  '- log/<年>/<月>/<日>/ 是原始流水，append-only，不改；引用原话必须带 log-addr。',
  '- agents/<agent-id>/identity/ 是本 agent 的 principle / preference / prompt。别的 agent 的 人格文件 不混用。',
  '- 先用 memory_search / memory_read 查；memory_add / memory_update 需要写权限；没有写权限就用 memory_propose，等用户接受。',
  '- 不要编原话，不要编 log-addr；没查到就说没查到，并说明搜索条件。',
  '- 写入后按当前环境做校验和提交；没有相应工具就明确说没做，不假装已经落盘。',
].join('\n')

/** 人类新建主 agent 时的人格文件初始文件：保留写作提示，不锁分类；提示槽位带默认环境说明。 */
export function defaultIdentityText(slot: Pick<IdentitySlot, 'id' | 'label'>): string {
  const hint = IDENTITY_HINTS[slot.id]
    ?? '这个槽位里写需要长期保留的内容。'
  if (slot.id === 'prompt') {
    return `# ${slot.label}

${hint}

${PROMPT_DEFAULT}
`
  }
  return `# ${slot.label}

${hint}

`
}

export class AgentManifestStore {
  readonly memoryRoot: string
  readonly agentsRoot: string

  constructor(memoryRoot: string) {
    this.memoryRoot = memoryRoot
    this.agentsRoot = join(memoryRoot, 'agents')
  }

  dir(agentId: string): string {
    assertSegment(agentId, 'agent id')
    return join(this.agentsRoot, agentId)
  }

  identityDir(agentId: string): string {
    return join(this.dir(agentId), 'identity')
  }

  path(agentId: string): string {
    return join(this.dir(agentId), 'agent.json')
  }

  slotPath(agentId: string, slot: IdentitySlot): string {
    const dir = this.identityDir(agentId)
    return assertWithin(dir, join(dir, assertFile(slot.file)), 'identity file')
  }

  read(agentId: string): AgentManifest | undefined {
    const path = this.path(agentId)
    if (!existsSync(path)) return undefined
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AgentManifest
    const manifest = validateAgentManifest(raw)
    if (manifest.id !== agentId) {
      throw new Error(`agent manifest id mismatch: ${manifest.id} vs ${agentId}`)
    }
    return manifest
  }

  readOrThrow(agentId: string): AgentManifest {
    const manifest = this.read(agentId)
    if (!manifest) throw new Error(`agent manifest not found: ${this.path(agentId)}`)
    return manifest
  }

  list(): AgentManifest[] {
    if (!existsSync(this.agentsRoot)) return []
    const out: AgentManifest[] = []
    for (const entry of readdirSync(this.agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const manifest = this.read(entry.name)
        if (manifest) out.push(manifest)
      } catch {
        // 坏 manifest 不阻断其他 agent 的列表
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  async write(manifest: AgentManifest): Promise<void> {
    const validated = validateAgentManifest(manifest)
    const path = this.path(validated.id)
    mkdirSync(this.dir(validated.id), { recursive: true })
    await withFileLock(path, () => {
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    }, { timeoutMs: 5_000 })
  }

  /**
   * 把 agent 目录挪到 `agents/.trash/<id>-<stamp>`。
   *
   * 不做物理删除：记忆库可能有 git，但 data 下的设置没有；留一份可人工找回。
   */
  removeToTrash(agentId: string, stamp: string): { from: string; to: string } {
    const from = this.dir(agentId)
    if (!existsSync(from)) throw new Error(`agent not found: ${agentId}`)
    const trashRoot = join(this.agentsRoot, '.trash')
    mkdirSync(trashRoot, { recursive: true })
    let to = join(trashRoot, `${agentId}-${stamp}`)
    let suffix = 1
    while (existsSync(to)) to = join(trashRoot, `${agentId}-${stamp}-${suffix++}`)
    renameSync(from, to)
    return { from, to }
  }

  async ensureDefault(
    agentId: string,
    name = agentId,
    labels: Partial<Record<IdentitySlotName, string>> = {},
  ): Promise<AgentManifest> {
    const existing = this.read(agentId)
    if (existing) return existing
    const manifest = defaultAgentManifest(agentId, name, labels)
    await this.write(manifest)
    return manifest
  }

  /** 人类新建主 agent：manifest + 三个空白 人格文件 文件。 */
  async createDefault(
    agentId: string,
    name = agentId,
    labels: Partial<Record<IdentitySlotName, string>> = {},
  ): Promise<AgentManifest> {
    if (this.read(agentId)) throw new Error(`agent already exists: ${agentId}`)
    const manifest = defaultAgentManifest(agentId, name, labels)
    const dirExisted = existsSync(this.dir(agentId))
    const manifestExisted = existsSync(this.path(agentId))
    try {
      await this.write(manifest)
      for (const slot of manifest.identity) {
        const path = this.slotPath(agentId, slot)
        mkdirSync(dirname(path), { recursive: true })
        if (!existsSync(path)) writeFileSync(path, defaultIdentityText(slot), 'utf8')
      }
    } catch (error) {
      // 半成品 agent 比“不存在”更难排查；本次新建的目录/清单写失败就回滚。
      if (!dirExisted) rmSync(this.dir(agentId), { recursive: true, force: true })
      else if (!manifestExisted) rmSync(this.path(agentId), { force: true })
      throw error
    }
    return manifest
  }
}
