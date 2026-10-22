/**
 * 默认装配：把配置变成一套能跑的服务。
 *
 * 原则：
 *   - 注册表都是实例，不碰模块级单例；
 *   - 默认只给只读工具，写/执行工具必须显式启用；
 *   - 子 agent 与主 agent 共用工具注册表，权限靠预设白名单收窄；
 *   - 关闭顺序由容器逆序保证，先停调度器再关存储。
 *
 * @module if/app/bundle
 */

import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentManager as AgentManagerType } from '../agents/manager.ts'
import { AgentManager } from '../agents/manager.ts'
import { PresetRegistry } from '../agents/presets.ts'
import { runSubagent } from '../agents/run.ts'
import type { AgentPreset, AgentRequest, AgentResult } from '../agents/types.ts'
import { TokenEstimator } from '../compaction/estimate.ts'
import { compactIfNeeded } from '../compaction/fold.ts'
import type { CompactionConfig, CompactionPayload } from '../compaction/types.ts'
import { staticSection, memorySection, timeSection } from '../context/sections.ts'
import type { ContextSection } from '../context/types.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { SessionWriter } from '../core/session-writer.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { defaultSources } from '../memory/sources.ts'
import type { ModelRegistry, ResolvedModel } from '../model/registry.ts'
import { ModelRegistry as Registry } from '../model/registry.ts'
import { projectHistory, type HistoryMessage } from '../projections/history.ts'
import { renderContext } from '../context/pipeline.ts'
import { runTurn, type RunResult } from '../loop/run.ts'
import { InMemoryApprovalRegistry } from '../tools/approval.ts'
import { createAgentControlTools } from '../tools/builtin/agent-control.ts'
import { bashTool } from '../tools/builtin/bash.ts'
import { editTool } from '../tools/builtin/edit.ts'
import { fetchTool } from '../tools/builtin/fetch.ts'
import { readTool } from '../tools/builtin/read.ts'
import { createRecallTool } from '../tools/builtin/recall.ts'
import { createRequestAgentTool } from '../tools/builtin/request-agent.ts'
import { websearchTool } from '../tools/builtin/websearch.ts'
import { writeTool } from '../tools/builtin/write.ts'
import { FileSpillStore, SpillPolicy } from '../tools/spill.ts'
import { ToolRegistry } from '../tools/registry.ts'
import {
  slicePayload,
  type UiApproval,
  type UiPayloadInput,
  type UiPayloadSlice,
  type UiSessionStats,
} from '../ui/api.ts'
import {
  projectUiTimeline,
  type UiTimelineItem,
  type UiTimelineOptions,
  type UiTimelinePage,
} from '../ui/timeline.ts'
import type { UiTurnMeta } from '../ui/index.ts'
import type { AppConfig } from './config.ts'
import type { Container } from './container.ts'
import { applyPatches, mergeCompaction, mergePool } from './patch.ts'
import {
  listAgentRuns,
  listSessions,
  newSessionId,
  sessionFile,
  uiIndexFile,
  type AgentRunInfo,
  type SessionInfo,
} from './session.ts'
import { UiIndex } from '../ui/index.ts'

/** 永远可用的只读工具。 */
const SAFE_TOOLS = [readTool, fetchTool, websearchTool] as const
/** 必须显式启用的工具：会改文件或执行命令。 */
const DANGEROUS_TOOLS = {
  write: writeTool,
  edit: editTool,
  bash: bashTool,
} as const

export interface ChatOptions {
  readonly sessionId: string
  readonly text: string
  readonly onModelEvent?: Parameters<typeof runTurn>[1]['onModelEvent']
  readonly signal?: AbortSignal
}

export interface App {
  readonly config: AppConfig
  readonly models: ModelRegistry
  readonly tools: ToolRegistry
  readonly presets: PresetRegistry
  readonly approvals: InMemoryApprovalRegistry
  readonly agents: AgentManagerType
  readonly compaction: CompactionConfig

  /** 发起一轮对话，落事件后返回统计。 */
  chat(options: ChatOptions): Promise<RunResult>
  /** 当前会话的历史投影。 */
  history(sessionId: string): readonly HistoryMessage[]
  /** UI 时间线分页；只返回预览，不展开全文。 */
  timeline(sessionId: string, options?: UiTimelineOptions): UiTimelinePage
  /** 全部轮的轻量元数据，供虚拟列表使用。 */
  uiTurns(sessionId: string): UiTurnMeta[]
  /** 某一轮的全部卡片。 */
  uiTurnItems(sessionId: string, turn: number): UiTimelineItem[]
  /** 按 ref/事件 id 取全文切片。 */
  payload(sessionId: string, input: UiPayloadInput): UiPayloadSlice
  /** UI 用的会话统计。 */
  uiStats(sessionId: string): UiSessionStats
  /** 待审批队列；不经过消息列表。 */
  uiApprovals(sessionId?: string): UiApproval[]
  /** 手动压缩；返回本次压缩载荷，没有可压的返回 null。 */
  compact(sessionId: string): Promise<CompactionPayload | null>
  /** 新建会话 id（不落盘，首次 chat 时创建）。 */
  createSession(): string
  /** 列举已有会话。 */
  sessions(): SessionInfo[]

  requestAgent(input: {
    preset: string
    prompt: string
    context?: string
    acceptance?: readonly string[]
    priority?: 'interactive' | 'normal' | 'background'
    sourceSession: string
    sourceTurn?: number
  }): AgentRequest
  agentStatus(id: string): AgentResult | 'queued' | 'running' | undefined
  agentList(limit?: number): ReturnType<AgentManagerType['list']>
  /** 从磁盘读全部 agent 终态，跨进程可用。 */
  agentRuns(): AgentRunInfo[]
  agentInterrupt(id: string): boolean
  /** 等子 agent 到终态；超时返回仍在跑/排队的数量。 */
  waitForAgents(timeoutMs?: number): Promise<{ active: number; queued: number }>

  dispose(): Promise<void>
}

export interface BuildOptions {
  readonly cwd?: string
  readonly now?: () => Date
}

export function buildBundle(rawConfig: AppConfig, container: Container, options: BuildOptions = {}): App {
  registerCoreEvents()

  const config = applyPatches(rawConfig)
  const cwd = options.cwd ?? process.cwd()
  const now = options.now ?? ((): Date => new Date())

  const sessionsRoot = join(config.profile.dataRoot, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })

  // 每个会话一个 store；同一进程里共用实例，避免重复打开。
  const stores = new Map<string, EventStore>()
  const storeFor = (sessionId: string): EventStore => {
    let store = stores.get(sessionId)
    if (!store) {
      store = new EventStore(sessionFile(config.profile.dataRoot, sessionId), {
        segmentMaxBytes: 8 * 1024 * 1024,
      })
      stores.set(sessionId, store)
    }
    return store
  }
  container.register('sessionStore', storeFor)

  // 每会话一个长写者；同一时刻只允许一个进程/实例持锁。
  const writers = new Map<string, SessionWriter>()
  const writerFor = (sessionId: string): SessionWriter => {
    const current = writers.get(sessionId)
    if (current && !current.closed) return current
    const writer = SessionWriter.open(storeFor(sessionId))
    writers.set(sessionId, writer)
    return writer
  }
  container.register('sessionWriter', writerFor)
  container.onDispose('sessionWriters', () => {
    for (const writer of writers.values()) writer.close()
    writers.clear()
  })

  // UI 元数据索引：只加速分页，不是真相；坏了回退到纯投影。
  const uiIndexes = new Map<string, UiIndex>()
  const uiIndexFor = (sessionId: string): UiIndex => {
    const current = uiIndexes.get(sessionId)
    if (current) return current
    const index = UiIndex.open(uiIndexFile(config.profile.dataRoot, sessionId))
    uiIndexes.set(sessionId, index)
    return index
  }
  container.onDispose('uiIndexes', () => {
    for (const index of uiIndexes.values()) index.close()
    uiIndexes.clear()
  })

  const ensureSession = (sessionId: string): EventStore => {
    const store = storeFor(sessionId)
    if (store.lineCount() === 0) {
      writerFor(sessionId).append({
        stream: sessionStream(sessionId),
        actor: 'system',
        type: 'session.created',
        payload: {
          sessionId,
          createdAt: now().toISOString(),
          formatVersion: 2,
          seqBase: 0,
        },
      })
    }
    return store
  }

  // 模型：配置提供，代码不猜。
  const models = new Registry()
  for (const provider of config.providers) models.register(provider)
  container.register('models', models)

  let defaultModel: ResolvedModel
  try {
    defaultModel = models.resolve(config.defaultModel.provider, config.defaultModel.model)
  } catch (error) {
    throw new Error(`defaultModel: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 工具：只读默认开，危险工具看名单。
  const tools = new ToolRegistry()
  for (const tool of SAFE_TOOLS) tools.register(tool, 'builtin')
  tools.register(createRecallTool(storeFor, {
    ...(config.profile.memoryLogRoot ? { memoryLogRoot: config.profile.memoryLogRoot } : {}),
  }), 'builtin')

  const dangerousEnabled = new Set(config.patch?.tools?.enabled ?? [])
  for (const [name, tool] of Object.entries(DANGEROUS_TOOLS)) {
    if (dangerousEnabled.has(name)) tools.register(tool, 'builtin')
  }
  container.register('tools', tools)

  // 预设：只从配置来，代码不写死模型名。
  const presets = new PresetRegistry()
  for (const preset of config.presets) presets.register(preset)
  container.register('presets', presets)

  const approvals = new InMemoryApprovalRegistry()
  container.register('approvals', approvals)

  const pool = mergePool(config.patch?.agents)
  const compaction = mergeCompaction(config.patch?.compaction)
  const estimator = new TokenEstimator()
  const spill = new SpillPolicy(new FileSpillStore(join(config.profile.dataRoot, 'spill')))

  const agents = new AgentManager({
    storeFactory: storeFor,
    writerFactory: writerFor,
    config: pool,
    runner: (request, signal, store, stream, writer) => runSubagent(request, signal, store, stream, {
      tools,
      approvals,
      profile: config.profile,
      cwd,
      ...(writer ? { writer } : {}),
      models,
    }),
    // 终态回送来源会话；正文自带分类标记，模型能认出这不是用户说的。
    deliver: (result, request) => {
      const writer = writerFor(request.source.session)
      const lines = [
        `子 agent 结束：${result.id}`,
        `预设：${result.preset}｜状态：${result.status}｜步数：${result.steps}`,
        result.summary ? `摘要：${result.summary}` : '',
        result.artifacts.length > 0 ? `产物：${result.artifacts.join('、')}` : '',
        result.error ? `错误：${result.error}` : '',
      ].filter(Boolean)

      writer.append({
        stream: sessionStream(request.source.session),
        actor: 'system',
        type: 'message.system',
        refs: { agentRequest: result.id },
        payload: {
          text: lines.join('\n'),
          mark: 'injection',
          requestId: result.id,
        },
      })
    },
  })
  container.register('agents', agents)
  // 先停调度器：它还会往 store 写终态。
  container.onDispose('agents', () => agents.dispose())

  // 派活与控制面放在 manager 之后注册：工具创建时要用到它。
  tools.register(createRequestAgentTool({ manager: agents, presets }), 'builtin')
  for (const tool of createAgentControlTools({ manager: agents })) {
    tools.register(tool, 'builtin')
  }

  // 上下文：请求头 + 身份/记忆 + 时间。记忆读不到就跳过。
  const sections: ContextSection[] = []
  if (config.profile.header) sections.push(staticSection('header', config.profile.header, 100))
  if (config.profile.agentDir) {
    sections.push(memorySection('memory', defaultSources(config.profile.agentDir), 90))
  }
  sections.push(timeSection())

  const maxBytes = config.patch?.context?.maxBytes

  let disposed = false

  const app: App = {
    config,
    models,
    tools,
    presets,
    approvals,
    agents,
    compaction,

    async chat(input) {
      const store = ensureSession(input.sessionId)
      const writer = writerFor(input.sessionId)
      return runTurn(input.text, {
        store,
        writer,
        sessionId: input.sessionId,
        profile: config.profile,
        model: defaultModel,
        tools,
        approvals,
        sections,
        cwd,
        now,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onModelEvent ? { onModelEvent: input.onModelEvent } : {}),
        compaction: {
          config: compaction,
          estimator,
          contextWindow: defaultModel.model.contextWindow ?? 128_000,
          ...(defaultModel.model.maxOutputTokens !== undefined
            ? { maxOutputTokens: defaultModel.model.maxOutputTokens }
            : {}),
          spill,
        },
      })
    },

    history(sessionId) {
      return projectHistory(storeFor(sessionId).read())
    },

    timeline(sessionId, options) {
      const store = storeFor(sessionId)
      try {
        const index = uiIndexFor(sessionId)
        index.sync(store)
        return index.page(sessionId, options)
      } catch {
        return projectUiTimeline(sessionId, store.read(), options)
      }
    },

    uiTurns(sessionId) {
      const store = storeFor(sessionId)
      try {
        const index = uiIndexFor(sessionId)
        index.sync(store)
        return index.turns()
      } catch {
        const page = projectUiTimeline(sessionId, store.read(), { limit: 200 })
        const map = new Map<number, UiTurnMeta>()
        for (const item of page.items) {
          const prev = map.get(item.turn)
          map.set(item.turn, {
            turn: item.turn,
            startSeq: prev?.startSeq ?? item.seq,
            endSeq: item.seq,
            itemCount: (prev?.itemCount ?? 0) + 1,
          })
        }
        return [...map.values()].sort((a, b) => a.turn - b.turn)
      }
    },

    uiTurnItems(sessionId, turn) {
      const store = storeFor(sessionId)
      try {
        const index = uiIndexFor(sessionId)
        index.sync(store)
        return index.itemsOfTurn(turn)
      } catch {
        return projectUiTimeline(sessionId, store.read(), { limit: 200 })
          .items
          .filter(item => item.turn === turn)
      }
    },

    payload(sessionId, input) {
      const store = storeFor(sessionId)
      let text: string | undefined
      let mime: string | undefined
      let encoding: string | undefined

      if (input.ref) {
        text = spill.store.get(input.ref)
        mime = 'text/plain'
        encoding = 'utf-8'
      } else if (input.eventId) {
        const event = store.read().find(item => item.id === input.eventId)
        if (!event) throw new Error(`event not found: ${input.eventId}`)
        const payload = event.payload as {
          text?: unknown
          ref?: unknown
          mime?: unknown
          encoding?: unknown
          contentRef?: { ref?: unknown } | undefined
        }
        const ref = typeof payload.ref === 'string'
          ? payload.ref
          : typeof payload.contentRef?.ref === 'string'
            ? payload.contentRef.ref
            : undefined
        text = ref ? spill.store.get(ref) : String(payload.text ?? '')
        mime = typeof payload.mime === 'string' ? payload.mime : undefined
        encoding = typeof payload.encoding === 'string' ? payload.encoding : 'utf-8'
      } else {
        throw new Error('payload needs ref or eventId')
      }

      return slicePayload(
        text,
        input.offset ?? 0,
        input.limit ?? 20_000,
        {
          ...(mime ? { mime } : {}),
          ...(encoding ? { encoding } : {}),
        },
      )
    },

    uiStats(sessionId) {
      const store = storeFor(sessionId)
      try {
        const index = uiIndexFor(sessionId)
        index.sync(store)
        return index.stats(sessionId, store)
      } catch {
        const events = store.read()
        const segments = store.segments()
        let fileBytes = 0
        for (const segment of segments) {
          try {
            fileBytes += statSync(segment).size
          } catch {
            // 段可能刚被轮转/清理
          }
        }
        return {
          sessionId,
          events: events.length,
          turns: events.filter(event => event.type === 'turn.completed').length,
          compacted: events.filter(event => event.type === 'context.compacted').length,
          pruned: events.filter(event => event.type === 'compaction.pruned').length,
          lastSeq: events.at(-1)?.seq ?? Math.max(0, events.length - 1),
          fileBytes,
          segments: segments.length,
        }
      }
    },

    uiApprovals(sessionId) {
      return approvals
        .pending()
        .filter(entry => !sessionId || entry.sessionId === sessionId)
        .map(entry => ({
          approvalId: entry.approvalId,
          sessionId: entry.sessionId,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          input: entry.originalInput,
        }))
    },

    async compact(sessionId) {
      const store = storeFor(sessionId)
      const writer = writerFor(sessionId)
      const history = projectHistory(store.read())
      const rendered = renderContext({
        sections,
        history,
        profile: config.profile,
        sessionId,
        turn: 1,
        now: now(),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      })
      const currentTurn = store.read().filter(event => event.type === 'turn.completed').length + 1

      return compactIfNeeded({
        store,
        writer,
        stream: sessionStream(sessionId),
        config: compaction,
        estimator,
        contextWindow: defaultModel.model.contextWindow ?? 128_000,
        ...(defaultModel.model.maxOutputTokens !== undefined
          ? { maxOutputTokens: defaultModel.model.maxOutputTokens }
          : {}),
        system: rendered.system,
        tools: tools.toModelSpecs(),
        messages: rendered.messages,
        currentTurn,
        projectMessages: () => projectHistory(store.read()),
        spill,
      })
    },

    createSession() {
      return newSessionId(now(), config.profile.timeZone)
    },

    sessions() {
      return listSessions(config.profile.dataRoot)
    },

    requestAgent(input) {
      const preset: AgentPreset | undefined = presets.get(input.preset)
      if (!preset) throw new Error(`unknown preset: ${input.preset}`)
      return agents.submit({
        preset: preset.id,
        prompt: input.prompt,
        ...(input.context ? { context: input.context } : {}),
        ...(input.acceptance ? { acceptance: input.acceptance } : {}),
        priority: input.priority ?? 'normal',
        source: {
          session: input.sourceSession,
          ...(input.sourceTurn !== undefined ? { turn: input.sourceTurn } : {}),
        },
      }, preset)
    },

    agentStatus(id) {
      return agents.status(id)
    },

    agentList(limit) {
      return agents.list(limit)
    },

    agentRuns() {
      return listAgentRuns(config.profile.dataRoot)
    },

    agentInterrupt(id) {
      return agents.interrupt(id)
    },

    async waitForAgents(timeoutMs = 30_000) {
      const started = Date.now()
      while (
        (agents.activeCount() > 0 || agents.queueLength() > 0)
        && Date.now() - started < timeoutMs
      ) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return { active: agents.activeCount(), queued: agents.queueLength() }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      await container.dispose()
    },
  }

  return app
}
