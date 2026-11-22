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

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentManager as AgentManagerType } from '../agents/manager.ts'
import { AgentManager } from '../agents/manager.ts'
import { PresetRegistry } from '../agents/presets.ts'
import { repairAgentStream } from '../agents/recovery.ts'
import { runSubagent } from '../agents/run.ts'
import {
  AgentSettingsStore,
  type AgentSettings,
  type ModelRef,
  type SubagentPolicy,
} from '../agents/settings.ts'
import type { AgentPreset, AgentRequest, AgentResult } from '../agents/types.ts'
import { TokenEstimator } from '../compaction/estimate.ts'
import { archiveCompactedSegments } from '../compaction/archive.ts'
import { compactIfNeeded } from '../compaction/fold.ts'
import type { CompactionConfig, CompactionPayload } from '../compaction/types.ts'
import { staticSection, sessionMemorySection, timeSection } from '../context/sections.ts'
import { memoryPushSection } from '../context/memory-push.ts'
import { memorySpacesSection } from '../context/memory-spaces.ts'
import type { ContextSection } from '../context/types.ts'
import { BlobStore } from '../core/blobs.ts'
import { FsPolicy } from '../core/fs-policy.ts'
import { HostLease } from '../core/host-lease.ts'
import { Metrics, type MetricsSnapshot } from '../core/metrics.ts'
import { backfillUsage } from '../usage/backfill.ts'
import { UsageLedger } from '../usage/ledger.ts'
import type {
  UsageBucket,
  UsageFilter,
  UsageGroupBy,
  UsageGroupRow,
  UsageLedgerStats,
  UsageOverview,
  UsageRequestPage,
  UsageTimeZone,
  UsageTimelinePoint,
} from '../usage/types.ts'
import { NetworkPolicy } from '../core/network-policy.ts'
import { RiskGuard } from '../core/risk-guard.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { WorkspaceLeaseManager } from '../core/workspace-lease.ts'
import { SessionWriter } from '../core/session-writer.ts'
import { EventStore } from '../core/store.ts'
import { agentStream, sessionStream } from '../core/streams.ts'
import { withFileLock } from '../core/lock.ts'
import { loadIdentitySources } from '../memory/sources.ts'
import { AgentManifestStore, type AgentManifest, type IdentitySlot } from '../memory/agent-manifest.ts'
import { AgentIdentityStore, type IdentityBackup } from '../memory/identity-slots.ts'
import { ManifestIdentityStore } from '../memory/identity-adapter.ts'
import { MemoryAccess, type MemoryRole } from '../memory/access.ts'
import { MemorySpaceAccess } from '../memory/space-access.ts'
import { MemorySpaceStore, spaceDir } from '../memory/space.ts'
import { MemoryCommitter } from '../memory/committer.ts'
import { MemoryLogService } from '../memory/internal-log.ts'
import { MemoryIdentityStore } from '../memory/identity.ts'
import {
  MemoryPolicyStore,
  type MemoryPolicy,
  type ResolvedMemoryPolicy,
} from '../memory/policy.ts'
import { ensureMemoryLayout, resolveMemoryRoot } from '../memory/root.ts'
import { MemorySearchIndex } from '../memory/search-index.ts'
import { MemorySummaryStore } from '../memory/summary.ts'
import { ModelSummaryGenerator } from '../memory/summary-model.ts'
import { MemorySummaryWorker, type SummaryWorkerStatus } from '../memory/summary-worker.ts'
import { HeuristicMemorySelector } from '../memory/selector.ts'
import { MemoryPushService } from '../memory/push.ts'
import { SemanticMemoryIndex } from '../memory/semantic-index.ts'
import { MemoryProposalStore, type MemoryAcceptResult, type MemoryProposal, type ProposalStatus } from '../memory/proposals.ts'
import { MemoryStore, type MemoryDocument, type MemoryEntry, type MemoryFileSummary, type MemorySearchHit } from '../memory/store.ts'
import type { Issue } from '../memory/validate.ts'
import { generateIndex, writeIndex, type IndexList } from '../memory/index.ts'
import {
  MemoryLibrary,
  type MemoryLibraryFile,
  type MemoryLibraryNode,
  type MemoryTrashEntry,
} from '../memory/library.ts'
import {
  listLogTree,
  readLogPage,
  searchLogs,
  type LogSearchResult,
  type LogTree,
  type LogViewPage,
} from '../memory/log-view.ts'
import { createMemoryTools } from '../memory/tools.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { IF_VERSION } from '../version.ts'
import {
  resolveUpdateLayout,
  UpdateService,
  type PendingUpdate,
  type UpdateCheckResult,
  type UpdateJob,
  type UpdateStatus,
} from './update.ts'
import type { ModelRegistry, ResolvedModel } from '../model/registry.ts'
import { EmbeddingInstallJobs, type EmbeddingInstallJob } from '../model/local/embedding-jobs.ts'
import { LocalEmbeddingService } from '../model/local/embedding-service.ts'
import {
  LocalEmbeddingStore,
  type EmbeddingModelStatus,
} from '../model/local/embedding-store.ts'
import type { ApiKeyConfig, ModelCard, ModelPricing, ProviderConfig } from '../model/types.ts'
import { BUILTIN_PROVIDERS } from '../model/builtin.ts'
import { apiUrl } from '../model/urls.ts'
import { validatePricing } from '../model/pricing.ts'
import { ModelRegistry as Registry } from '../model/registry.ts'
import { BalanceInputError, ModelBalanceService, type ModelBalance } from '../model/balance.ts'
import { normalizeEndpointFamily, supportsAssistantPrefill } from '../model/chat-model.ts'
import { ModelGate, type ModelPriority } from '../model/gate.ts'
import { resolveRetryPolicy } from '../model/retry.ts'
import {
  SessionGraph,
  type CreateLinkInput,
  type LinkQuery,
  type SessionLink,
} from '../graph/links.ts'
import {
  inspectEvents,
  tailSession,
  type SessionInspection,
  type SessionTail,
  type SessionTailOptions,
} from './inspect.ts'
import { SessionHost } from '../session/host.ts'
import { pendingWakeMessages } from '../session/inbox.ts'
import { SessionMetaStore, type SessionMeta, type SessionMetaPatch } from '../session/meta.ts'
import {
  SessionBusyError,
  SessionLifecycle,
  type SessionLifecycleRecord,
  type SessionLifecycleState,
} from '../session/lifecycle.ts'
import {
  SessionJoinScheduler,
  type SessionJoinInput,
  type SessionJoinRecord,
} from '../session/joins.ts'
import type {
  SendSessionMessageInput,
  SessionMessageDelivery,
} from '../session/message.ts'
import { projectHistory, type HistoryMessage } from '../projections/history.ts'
import { renderContext } from '../context/pipeline.ts'
import { runTurn, type RunResult } from '../loop/run.ts'
import { InMemoryApprovalRegistry } from '../tools/approval.ts'
import { createAgentControlTools } from '../tools/builtin/agent-control.ts'
import { bashTool } from '../tools/builtin/bash.ts'
import { createSessionJoinTool } from '../tools/builtin/session-join.ts'
import { createSessionCreateTool, type SpawnedSession } from '../tools/builtin/session-create.ts'
import { createSessionMessageTool } from '../tools/builtin/session-message.ts'
import { editTool } from '../tools/builtin/edit.ts'
import { fetchTool } from '../tools/builtin/fetch.ts'
import { readTool } from '../tools/builtin/read.ts'
import { createRecallTool } from '../tools/builtin/recall.ts'
import { createRequestAgentTool, modelListTool } from '../tools/builtin/request-agent.ts'
import { websearchTool } from '../tools/builtin/websearch.ts'
import { writeTool } from '../tools/builtin/write.ts'
import { OffloadPolicy } from '../tools/offload.ts'
import { FileSpillStore, SpillPolicy } from '../tools/spill.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { PluginRegistry } from '../plugins/registry.ts'
import { createExamplePlugin } from '../plugins/builtin/example.ts'
import type {
  PluginInfo,
  PluginListResult,
  PluginPanelContent,
} from '../plugins/types.ts'
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
import { AgentModelInvalidError, AgentModelMissingError } from './errors.ts'
import { applyPatches, mergeCompaction, mergeOffload, mergePool } from './patch.ts'
import { repairInterruptedSession, settleInterruptedApprovals } from './repair.ts'
import {
  listAgentRuns,
  listSessions,
  newSessionId,
  readSessionTail,
  sessionFile,
  sessionInfo,
  uiIndexFile,
  type AgentRunInfo,
  type SessionInfo,
} from './session.ts'
import { UiIndex } from '../ui/index.ts'

const TERMINAL_AGENT_STATUS = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

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
  readonly priority?: ModelPriority
  readonly onModelEvent?: Parameters<typeof runTurn>[1]['onModelEvent']
  readonly signal?: AbortSignal
}

export interface CreateSessionInput {
  /** 用户自定义会话 ID；不传则生成 session-时间戳-随机。 */
  readonly id?: string
  readonly createdBy?: string
  readonly createdFrom?: { readonly sessionId: string; readonly eventId?: string }
  /** 所属主 agent；不传时按配置 mainAgentId 回退。 */
  readonly agentId?: string
  readonly reason?: string
  /** true = 立即写 session.created；默认只在首次 chat 时落盘 */
  readonly materialize?: boolean
}

export interface SessionListOptions {
  readonly includeArchived?: boolean
  readonly includeDeleted?: boolean
}

export interface MemoryPolicyUpdate {
  readonly scope: 'default' | 'agent' | 'session'
  /** agent/session 作用域必填 */
  readonly id?: string
  readonly policy: MemoryPolicy
}

export interface SessionLifecycleInput {
  readonly by?: string
  readonly reason?: string
  /** 正在跑时仍允许归档/删除；不会中止当前轮，只阻止后续唤醒 */
  readonly force?: boolean
}

export interface UsageOverviewOptions {
  readonly timeZone?: UsageTimeZone
}

export interface UsageTimelineOptions {
  readonly bucket?: UsageBucket
  readonly timeZone?: UsageTimeZone
}

export interface UsageGroupsOptions {
  readonly groupBy: UsageGroupBy
  readonly limit?: number
}

export interface UsageRequestOptions {
  readonly limit?: number
  readonly offset?: number
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
  createSession(input?: CreateSessionInput): string
  /** 列举已有会话；扁平列表，不用父子树。默认只列 active。 */
  sessions(options?: SessionListOptions): SessionInfo[]
  /** 启动时扫一遍所有会话，补跑未处理的 wake 消息；返回有 pending 的会话数。 */
  recoverInboxes(): number
  /** 会话当前生命周期状态；没有记录就是 active。 */
  sessionState(sessionId: string): SessionLifecycleState
  archiveSession(sessionId: string, input?: SessionLifecycleInput): SessionLifecycleRecord
  unarchiveSession(sessionId: string, input?: SessionLifecycleInput): SessionLifecycleRecord
  /** 软删除；关闭连接、取消涉及它的等待，不删盘。 */
  deleteSession(sessionId: string, input?: SessionLifecycleInput): SessionLifecycleRecord
  /** 设置会话分类/置顶；写在 workspace 流，不进模型上下文。 */
  setSessionMeta(sessionId: string, input: SessionMetaPatch): SessionMeta
  /** 只读事件尾部；调试用，不进模型上下文。 */
  sessionEvents(sessionId: string, options?: SessionTailOptions): SessionTail
  /** 会话当前状态、pending 工具与连接。 */
  inspectSession(sessionId: string): SessionInspection

  /** 往另一个已连接会话投递消息；目标空闲时按 wake 策略开一轮。 */
  sendMessage(input: SendSessionMessageInput): SessionMessageDelivery
  /** agent 主动创建用户所有的会话，自动 peer 连接并发送第一条任务。 */
  spawnSession(input: { creator: string; text: string; reason?: string }): SpawnedSession
  /** 手动唤醒一个会话；text 会作为 system 注入写入它的流。 */
  wake(sessionId: string, text?: string): Promise<RunResult>
  /** 等待一组已连接会话；不阻塞模型。 */
  join(input: SessionJoinInput): SessionJoinRecord
  /** 取消等待；返回取消数量。 */
  cancelJoins(sessionId: string, joinId?: string): number
  /** 当前未完成的等待。 */
  pendingJoins(sessionId?: string): SessionJoinRecord[]

  /** 会话连接图。不传 sessionId 就返回全图。 */
  links(sessionId?: string, options?: LinkQuery): SessionLink[]
  /** 建立连接；createdBy 默认 user，只做溯源。 */
  link(input: CreateLinkInput): SessionLink
  /** 关闭连接；不删除历史，只追加 closed 事件。 */
  unlink(linkId: string, reason?: string): SessionLink | undefined

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
  /** 从磁盘读全部 agent 终态，跨进程可用；默认只列 active。 */
  agentRuns(options?: SessionListOptions): AgentRunInfo[]
  agentInterrupt(id: string): boolean
  /** 等子 agent 到终态；超时返回仍在跑/排队的数量。 */
  waitForAgents(timeoutMs?: number): Promise<{ active: number; queued: number }>
  /** 进程内指标快照；关闭指标时返回空快照。 */
  metrics(): MetricsSnapshot

  /** 用量账本状态（条数与回填进度）。 */
  usageStats(): UsageLedgerStats
  /** 用量总览：聚合 + 活跃日 / 连胜 / 峰值等派生指标。 */
  usageOverview(filter: UsageFilter, options?: UsageOverviewOptions): UsageOverview
  /** 用量时间线；同一 bucket 多币种时按 currency 拆行。 */
  usageTimeline(filter: UsageFilter, options?: UsageTimelineOptions): readonly UsageTimelinePoint[]
  /** 用量分组排行（provider/model/agent/session/key/source/...）。 */
  usageGroups(filter: UsageFilter, options: UsageGroupsOptions): readonly UsageGroupRow[]
  /** 用量请求明细分页，按时间倒序。 */
  usageRequests(filter: UsageFilter, options?: UsageRequestOptions): UsageRequestPage

  /** 本地 embedding 模型清单与安装状态。 */
  embeddingModels(): EmbeddingModelStatus[]
  /** 启动一键下载/安装任务；返回可轮询的 job。 */
  startEmbeddingInstall(id: string, options?: { mirror?: boolean }): EmbeddingInstallJob
  embeddingInstallJob(id: string): EmbeddingInstallJob | undefined
  activateEmbeddingModel(id: string): EmbeddingModelStatus
  removeEmbeddingModel(id: string): EmbeddingModelStatus[]

  /** 当前模型配置的脱敏视图（不回传 API key）。 */
  modelConfig(): ModelConfigView
  /** 更新 provider 的端点或 API key；有 configPath 时写回配置文件。 */
  saveModelConfig(input: ModelConfigUpdate): Promise<ModelConfigView>
  /** 添加一个新的模型服务商；有 configPath 时写回配置文件。 */
  addModelProvider(input: ModelProviderInput): Promise<ModelConfigView>
  /** 添加时的内置模板（不会自动注册成 provider）。 */
  modelProviderTemplates(): readonly ProviderConfig[]
  /** 追加一个 API key；可带标签。 */
  addModelApiKey(input: ModelApiKeyInput): Promise<ModelConfigView>
  /** 删除一个 API key。 */
  removeModelApiKey(input: ModelApiKeyRemoveInput): Promise<ModelConfigView>
  /** 修改 API key 的标签或启用状态。 */
  updateModelApiKey(input: ModelApiKeyUpdateInput): Promise<ModelConfigView>
  /** 只有用户明确点击「显示」时才取完整 key。 */
  revealModelApiKey(input: ModelApiKeyRemoveInput): string
  /** 查询单个 key 的上游余额；不支持时抛 balance_unsupported。 */
  modelBalance(input: ModelBalanceInput): Promise<ModelBalance>
  /** 用 provider 的 key / baseUrl 调模型列表接口，返回模型 id。 */
  probeModelProvider(input: ModelProbeInput): Promise<{ models: readonly string[] }>
  /** 给已有 provider 追加模型；重复 id 跳过。 */
  addProviderModels(input: ModelProviderModelsInput): Promise<ModelConfigView>
  /** 删除用户自建 provider；内置或正在被 agent 使用时拒绝。 */
  removeModelProvider(provider: string): Promise<ModelConfigView>
  /** 更新单个模型的上下文/输出/价格；有 configPath 时写回配置文件。 */
  saveModelCard(input: ModelCardUpdate): Promise<ModelConfigView>

  /** 主 agent manifest 列表；没有 memoryRoot 返回空。 */
  mainAgents(): readonly AgentManifest[]
  /** 主 agent 的显示摘要（manifest + 运行设置）。 */
  agentSummaries(): AgentSummary[]
  agentSummary(agentId: string): AgentSummary
  updateAgentSettings(agentId: string, input: AgentSettingsUpdate): Promise<AgentSummary>
  /** 新建主 agent：manifest + 三份空白 人格文件 文件。 */
  createMainAgent(input: { id: string; name: string }): Promise<AgentManifest>
  /** 删除主 agent：目录挪进 .trash；默认主 agent 和还有会话的 agent 不可删。 */
  deleteMainAgent(agentId: string): Promise<DeletedAgentSummary>
  /** 读主 agent 的 人格文件 槽位全文。 */
  mainAgentIdentity(agentId: string): {
    manifest: AgentManifest
    slots: Array<IdentitySlot & { path: string; content: string }>
  }
  /** 人类 UI 整文件保存 人格文件 槽位；先备份再写。 */
  writeMainAgentSlot(
    agentId: string,
    slotId: string,
    content: string,
  ): Promise<{ path: string; backup: string }>
  /** 人格文件 `_archive` 里的备份。 */
  mainAgentIdentityBackups(agentId: string): readonly IdentityBackup[]
  /** 恢复一份人格备份；恢复前会先备份当前版本。 */
  restoreMainAgentIdentity(
    agentId: string,
    file: string,
  ): Promise<{ slot: string; path: string; backup: string }>

  /** 工具列表；带 agentId 时附带该 agent 的白名单/审批覆盖。 */
  toolViews(agentId?: string): ToolView[]
  /** 全局工具启停/审批；有 configPath 时写回配置文件。 */
  setToolGlobal(name: string, input: ToolGlobalUpdate): Promise<ToolView[]>

  /** 内置更新器：当前安装布局与更新状态。 */
  updateStatus(): UpdateStatus
  /** 读更新清单并比较版本。 */
  checkUpdate(): Promise<UpdateCheckResult>
  /** 后台下载、校验并暂存；立即返回 job。 */
  startUpdateDownload(): UpdateJob
  /** 轮询下载/暂存进度。 */
  updateJob(): UpdateJob
  /** 手动暂存本地更新包（zip 路径）。 */
  stageUpdatePackage(zipPath: string): Promise<{ version: string; program: string }>
  /** 写 pending，下次启动前切换。 */
  applyUpdate(): PendingUpdate
  /** 写回滚 pending，下次启动前回滚。 */
  rollbackUpdate(): PendingUpdate
  /** 保存更新源；有 configPath 时写回配置文件。 */
  saveUpdateConfig(input: { manifestUrl?: string }): Promise<UpdateStatus>

  /** 插件列表与扫描错误。 */
  pluginList(): PluginListResult
  /** 启用插件并等待激活；失败会抛错。 */
  pluginEnable(id: string): Promise<PluginInfo>
  /** 停用插件并回滚注册项。 */
  pluginDisable(id: string): Promise<PluginInfo>
  /** 取面板 HTML；只给 sandbox iframe。 */
  pluginPanel(pluginId: string, panelId: string): PluginPanelContent | undefined

  /** 内置记忆库根；关闭记忆时 undefined。 */
  memoryRoot(): string | undefined
  /** 当前会话/agent 的记忆策略；不传 session 只看默认与 agent。 */
  memoryPolicy(sessionId?: string, agentId?: string): ResolvedMemoryPolicy
  /** 修改全局 / agent / session 策略。 */
  setMemoryPolicy(input: MemoryPolicyUpdate): ResolvedMemoryPolicy
  /** 当前会话的记忆角色；未配置记忆返回 undefined。 */
  memoryRole(sessionId: string): MemoryRole | undefined
  /** 只由用户/App 调用：给任意会话授予记忆角色。 */
  grantMemory(sessionId: string, role: MemoryRole): MemoryRole
  /** 全局 detail 记忆搜索。 */
  memorySearch(query: string, limit?: number): MemorySearchHit[]
  /** 全局 detail 记忆文件索引（域 / 文件 / 条数）。 */
  memoryIndex(): MemoryFileSummary[]
  /** 记忆库完整树（含私域、坏文件、结构目录）。 */
  memoryLibraryTree(): MemoryLibraryNode[]
  /** 读任意可编辑库文件；detail 坏文件也返回 raw text。 */
  memoryLibraryRead(path: string): MemoryLibraryFile
  /** 写任意可编辑库文件；detail 走 MemoryStore 校验。 */
  memoryLibraryWrite(path: string, text: string): Promise<MemoryLibraryFile>
  /** 新建目录。 */
  memoryLibraryMkdir(path: string): Promise<void>
  /** 移动/重命名文件或目录。 */
  memoryLibraryMove(from: string, to: string): Promise<void>
  /** 删除到回收站；permanent=true 永久删除。 */
  memoryLibraryRemove(path: string, permanent?: boolean): Promise<void>
  /** 回收站列表。 */
  memoryLibraryTrash(): MemoryTrashEntry[]
  /** 从回收站恢复。 */
  memoryLibraryRestore(id: string, to?: string): Promise<void>
  /** 记忆库 git 提交状态。 */
  memoryCommitStatus(): { gitRoot?: string; enabled: boolean; dirty: readonly string[] }
  /** 手动提交当前 dirty（autoCommit 关闭时也可用）。 */
  commitMemory(): Promise<void>
  /** 把需要更新的共享 detail 摘要排进后台队列；不占对话会话。 */
  rebuildMemorySummaries(): { queued: number; status: SummaryWorkerStatus }
  /** 摘要后台队列的实时状态。 */
  memorySummaryStatus(): SummaryWorkerStatus
  /** indexlist 索引（只读，自动生成）。 */
  memoryIndexList(): IndexList
  /** 重算并写回 detail/indexlist.json。 */
  reindexMemory(): IndexList
  /** 日志树（天 → 会话）。 */
  memoryLogTree(): LogTree
  /** 日志分页；jumpN 给前后文与 focus。 */
  memoryLogPage(
    day: string,
    sid: string,
    options?: { offset?: number; limit?: number; jumpN?: number },
  ): LogViewPage
  /** 全库搜日志。 */
  memoryLogSearch(query: string, limit?: number): LogSearchResult
  /** 读一个 detail 记忆文档。 */
  memoryRead(target: string): MemoryDocument
  /** 人类 UI 整文件保存；校验不过抛 MemoryValidationError。 */
  saveMemoryDocument(
    target: string,
    doc: MemoryDocument,
  ): Promise<{ document: MemoryDocument; warnings: readonly Issue[] }>
  memoryProposals(status?: ProposalStatus): MemoryProposal[]
  acceptMemoryProposal(proposalId: string): Promise<MemoryAcceptResult>
  rejectMemoryProposal(proposalId: string): MemoryProposal

  dispose(): Promise<void>
}

export interface ModelApiKeyView {
  readonly id: string
  /** 用户起的标签；没起就不显示 */
  readonly name?: string
  /** 脱敏后的展示串；不是完整密钥 */
  readonly preview: string
  readonly isEnabled: boolean
  /** 旧版单密钥，只读展示；可以删除或显示 */
  readonly legacy?: boolean
}

export interface ModelConfigProviderView {
  readonly id: string
  readonly name: string
  readonly endpointFamily: string
  /** 所有已配置的端点格式；决定详情页能切哪些格式 */
  readonly endpointFamilies: readonly string[]
  readonly endpoints: ReadonlyArray<{ readonly family: string; readonly baseUrl: string }>
  readonly baseUrl: string
  readonly models: Array<{
    readonly id: string
    readonly name?: string
    readonly contextWindow?: number
    readonly maxOutputTokens?: number
    readonly pricing?: ModelPricing
    readonly enabled: boolean
  }>
  readonly apiKeys: readonly ModelApiKeyView[]
  readonly hasApiKey: boolean
  /** 上游是否提供可直接用 key 查询的余额接口。 */
  readonly balanceSupported: boolean
  readonly apiKeyEnv?: string
  readonly enabled: boolean
  /** 配置里的 provider 都可以删；模板不会进这里。 */
  readonly removable: boolean
}

export interface ModelConfigView {
  readonly timeZone: string
  readonly providers: readonly ModelConfigProviderView[]
}

export interface ModelConfigUpdate {
  readonly provider: string
  /** 空字符串表示不改；不传也保持原值。 */
  readonly apiKey?: string
  readonly baseUrl?: string
  /** 要改哪个端点格式；不传改默认端点。 */
  readonly format?: string
  readonly enabled?: boolean
}

export interface ModelApiKeyInput {
  readonly provider: string
  readonly key: string
  readonly name?: string
  readonly isEnabled?: boolean
}

export interface ModelApiKeyRemoveInput {
  readonly provider: string
  readonly keyId: string
}

export interface ModelBalanceInput {
  readonly provider: string
  readonly keyId: string
  /** true = 跳过服务端 60 秒余额缓存。 */
  readonly refresh?: boolean
}

export interface ModelApiKeyUpdateInput {
  readonly provider: string
  readonly keyId: string
  /** 传空字符串表示去掉标签 */
  readonly name?: string
  readonly isEnabled?: boolean
}

export interface ModelCardUpdate {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number | null
  readonly maxOutputTokens?: number | null
  readonly pricing?: ModelPricing | null
  readonly enabled?: boolean
}

export interface ModelProviderModelInput {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export interface ModelProviderInput {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** 默认端点的 baseUrl；也在 endpoints 里时以这里为准 */
  readonly baseUrl: string
  readonly apiKey?: string
  /** 新 key 的标签；只在 apiKey 非空时有意义 */
  readonly apiKeyName?: string
  readonly apiKeyEnv?: string
  /** 默认端点格式：openai-chat-completions / openai-responses / anthropic-messages / google-generate-content */
  readonly format?: string
  /** 一次加入多个端点格式；不传就只建 format 一个 */
  readonly endpoints?: Readonly<Record<string, { readonly baseUrl: string }>>
  readonly models: readonly ModelProviderModelInput[]
}

export interface ModelProviderModelsInput {
  readonly provider: string
  readonly models: readonly ModelProviderModelInput[]
}

export interface ModelProbeInput {
  readonly provider: string
  /** 未保存的草稿 key；不传就用已保存的。 */
  readonly apiKey?: string
  /** 未保存的草稿 baseUrl；不传就用已保存的。 */
  readonly baseUrl?: string
  /** 要探测的端点格式；不传用默认端点。 */
  readonly format?: string
}

export interface AgentPresetSummary {
  readonly id: string
  readonly description: string
}

export interface AgentSummary {
  readonly id: string
  readonly name: string
  readonly hasManifest: boolean
  readonly model?: ModelRef
  readonly modelConfigured: boolean
  /** 当前主模型的端点是否支持 assistant prefill。 */
  readonly prefillSupported: boolean
  readonly subagentModels: readonly ModelRef[]
  readonly subagentPresets?: readonly string[]
  readonly availablePresets: readonly AgentPresetSummary[]
  readonly tools: {
    readonly allow?: readonly string[]
    readonly approval?: Readonly<Record<string, 'auto' | 'required'>>
  }
  /** 未删除的会话数（含归档）；还有会话就不允许删 agent。 */
  readonly sessionCount: number
  readonly deletable: boolean
  readonly deleteBlockedReason?: string
}

export interface DeletedAgentSummary {
  readonly id: string
  readonly trash: readonly string[]
}

export interface AgentSettingsUpdate {
  readonly model?: ModelRef
  readonly subagentModels?: readonly ModelRef[]
  readonly subagentPresets?: readonly string[]
  readonly tools?: {
    readonly allow?: readonly string[]
    readonly approval?: Readonly<Record<string, 'auto' | 'required'>>
  }
}

export interface ToolView {
  readonly name: string
  readonly description?: string
  readonly source: string
  readonly enabled: boolean
  readonly approval: 'auto' | 'required'
  readonly dangerous: boolean
  readonly readOnly: boolean
  readonly agentAllowed: boolean
  readonly agentApproval?: 'auto' | 'required'
  readonly effectiveApproval: 'auto' | 'required'
}

export interface ToolGlobalUpdate {
  readonly enabled?: boolean
  readonly approval?: 'auto' | 'required'
}

export interface BuildOptions {
  readonly cwd?: string
  readonly now?: () => Date
  readonly configPath?: string
}

interface RawModelEntry {
  id?: string
  name?: string
  apiModelId?: string
  capabilities?: string[]
  inputModalities?: string[]
  outputModalities?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  pricing?: ModelPricing
  enabled?: boolean
}

interface RawApiKeyEntry {
  id?: string
  name?: string
  key?: string
  isEnabled?: boolean
}

interface RawProviderEntry {
  id?: string
  name?: string
  description?: string
  apiKeys?: RawApiKeyEntry[]
  apiKey?: string
  apiKeyEnv?: string
  enabled?: boolean
  defaultChatEndpoint?: string
  endpoints?: Record<string, {
    baseUrl?: string
    adapterFamily?: string
    headers?: Record<string, string>
    reasoningFormat?: string
  }>
  models?: RawModelEntry[]
}

interface RawConfigFile {
  providers?: RawProviderEntry[]
  patch?: {
    tools?: {
      enabled?: string[]
      disabled?: string[]
      approval?: Record<string, 'auto' | 'required'>
    }
  }
  [key: string]: unknown
}

export function buildBundle(rawConfig: AppConfig, container: Container, options: BuildOptions = {}): App {
  registerCoreEvents()

  const config = applyPatches(rawConfig)
  const cwd = options.cwd ?? process.cwd()
  const now = options.now ?? ((): Date => new Date())
  const memoryRoot = resolveMemoryRoot(config.profile)
  if (memoryRoot) ensureMemoryLayout(memoryRoot)
  const embeddingStore = new LocalEmbeddingStore(
    join(config.profile.dataRoot, 'models', 'embeddings'),
  )
  let semanticMemoryIndex: SemanticMemoryIndex | undefined
  const embeddingJobs = new EmbeddingInstallJobs(embeddingStore, () => {
    void semanticMemoryIndex?.build().catch(() => undefined)
  })
  const embeddingService = new LocalEmbeddingService(embeddingStore)
  container.register('embeddingStore', embeddingStore)
  container.register('embeddingJobs', embeddingJobs)
  container.register('embeddingService', embeddingService)
  container.onDispose('embeddingService', () => embeddingService.dispose())
  const defaultAgentId = config.profile.principals.agents?.[0]?.id ?? 'main'
  const memoryLog = memoryRoot && config.profile.memory?.log !== false
    ? new MemoryLogService({
      memoryRoot,
      timeZone: config.profile.timeZone,
      userName: config.profile.principals.user?.name ?? 'user',
      metaFor: sessionId => {
        const info = sessionInfo(config.profile.dataRoot, sessionId)
        const agentId = info?.agentId ?? defaultAgentId
        const agent = config.profile.principals.agents?.find(item => item.id === agentId)
        return {
          agentId,
          agentName: agent?.name ?? agentId,
          cwd,
        }
      },
    })
    : undefined
  if (memoryLog) {
    container.register('memoryLog', memoryLog)
    container.onDispose('memoryLog', () => memoryLog.flush())
  }

  // 一个 dataRoot 只允许一个 host。锁是内核事务，进程崩溃时自动释放；
  // 不设 TTL，避免抢走还活着但卡死的写者。
  const hostLeaseConfig = config.patch?.runtime?.hostLease
  const hostLease = hostLeaseConfig?.enabled === false
    ? undefined
    : HostLease.acquire(config.profile.dataRoot, {
      ...(hostLeaseConfig?.lockDir ? { lockDir: hostLeaseConfig.lockDir } : {}),
      now,
    })
  if (hostLease) {
    container.register('hostLease', hostLease)
    container.onDispose('hostLease', () => hostLease.release())
  }

  // 运行时策略：默认开；配置可以关，但关的是检查，不是事件记录。
  const metrics = config.patch?.runtime?.metrics === false ? undefined : new Metrics()
  const usageLedger = UsageLedger.openForDataRoot(config.profile.dataRoot)
  container.register('usageLedger', usageLedger)
  container.onDispose('usageLedger', () => usageLedger.close())
  const usagePatch = config.patch?.runtime?.usage
  setImmediate(() => {
    void backfillUsage(config.profile.dataRoot, usageLedger)
      .then(() => {
        // 回填完再按保留策略聚合清理：早于保留期的明细聚成日汇总后删除。
        if (usagePatch?.rollupOnStart === false) return
        usageLedger.rollup({ detailDays: usagePatch?.detailRetentionDays ?? 1095 })
      })
      .catch(() => undefined)
  })
  const modelRetry = resolveRetryPolicy(config.patch?.runtime?.model?.retry)
  const admission = config.patch?.runtime?.model?.admission
  const modelGate = admission?.enabled === false
    ? undefined
    : new ModelGate({
      ...(admission?.maxConcurrentPerProvider !== undefined
        ? { maxConcurrentPerProvider: admission.maxConcurrentPerProvider }
        : {}),
      ...(admission?.requestsPerMinute !== undefined
        ? { requestsPerMinute: admission.requestsPerMinute }
        : {}),
      ...(admission?.queueLimit !== undefined ? { queueLimit: admission.queueLimit } : {}),
      ...(admission?.waitMs !== undefined ? { waitMs: admission.waitMs } : {}),
      ...(admission?.cooldownBaseMs !== undefined
        ? { cooldownBaseMs: admission.cooldownBaseMs }
        : {}),
      ...(admission?.cooldownMaxMs !== undefined
        ? { cooldownMaxMs: admission.cooldownMaxMs }
        : {}),
      ...(admission?.providers ? { providers: admission.providers } : {}),
    })
  if (modelGate) {
    container.register('modelGate', modelGate)
    container.onDispose('modelGate', () => modelGate.dispose())
  }

  const fsPatch = config.patch?.runtime?.fs
  const defaultFsRoots = [cwd, memoryRoot, config.profile.agentDir]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
  const fsPolicy = fsPatch?.enforce === false
    ? undefined
    : new FsPolicy({
      readRoots: fsPatch?.readRoots ?? defaultFsRoots,
      ...(fsPatch?.writeRoots ? { writeRoots: fsPatch.writeRoots } : {}),
    })

  const networkPatch = config.patch?.runtime?.network
  const networkPolicy = networkPatch?.enforce === false
    ? undefined
    : new NetworkPolicy({
      ...(networkPatch?.allowPrivateNetwork !== undefined
        ? { allowPrivateNetwork: networkPatch.allowPrivateNetwork }
        : {}),
      ...(networkPatch?.allowHosts ? { allowHosts: networkPatch.allowHosts } : {}),
      ...(networkPatch?.denyHosts ? { denyHosts: networkPatch.denyHosts } : {}),
      ...(networkPatch?.maxRedirects !== undefined
        ? { maxRedirects: networkPatch.maxRedirects }
        : {}),
    })

  // 风险守卫独立于 FS/Network 策略；关掉只表示不额外发问，危险工具本身仍要审批。
  const riskGuardConfig = config.patch?.runtime?.riskGuard
  const riskGuard = new RiskGuard({
    enabled: riskGuardConfig?.enabled !== false,
    ...(riskGuardConfig?.mode ? { mode: riskGuardConfig.mode } : {}),
    ...(riskGuardConfig?.askLevel ? { askLevel: riskGuardConfig.askLevel } : {}),
    ...(riskGuardConfig?.denyLevel ? { denyLevel: riskGuardConfig.denyLevel } : {}),
  })
  container.register('riskGuard', riskGuard)

  const workspaceConfig = config.patch?.runtime?.workspace
  const leaseConfig = workspaceConfig?.lease
  const leases = leaseConfig?.enabled === false
    ? undefined
    : new WorkspaceLeaseManager({
      ...(leaseConfig?.pathTtlMs !== undefined ? { pathTtlMs: leaseConfig.pathTtlMs } : {}),
      ...(leaseConfig?.workspaceTtlMs !== undefined
        ? { workspaceTtlMs: leaseConfig.workspaceTtlMs }
        : {}),
      ...(leaseConfig?.waitMs !== undefined ? { waitMs: leaseConfig.waitMs } : {}),
      ...(leaseConfig?.renewMs !== undefined ? { renewMs: leaseConfig.renewMs } : {}),
      ...(leaseConfig?.maxQueue !== undefined ? { maxQueue: leaseConfig.maxQueue } : {}),
    })
  const workspaceId = workspaceConfig?.id ?? cwd
  if (leases) {
    container.register('workspaceLeases', leases)
    container.onDispose('workspaceLeases', () => leases.dispose())
  }

  const sessionsRoot = join(config.profile.dataRoot, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })

  // 连接图是独立 workspace 事件流：不属于任何一个会话，也不进父子树。
  const graphStore = new EventStore(join(config.profile.dataRoot, 'workspace.jsonl'), {
    segmentMaxBytes: 4 * 1024 * 1024,
  })
  const graphWriter = SessionWriter.open(graphStore)
  const sessionGraph = new SessionGraph(graphStore, graphWriter)
  container.register('sessionGraph', sessionGraph)
  container.onDispose('sessionGraph', () => graphWriter.close())

  // 生命周期、分类/置顶和 link 共用 workspace 流；不写会话自己的日志。
  const sessionLifecycle = new SessionLifecycle(graphStore, graphWriter)
  container.register('sessionLifecycle', sessionLifecycle)
  const sessionMeta = new SessionMetaStore(graphStore, graphWriter)
  container.register('sessionMeta', sessionMeta)

  // 同一会话同一时刻只允许一个 turn；不同会话并行。
  const sessionHost = new SessionHost()
  container.register('sessionHost', sessionHost)
  container.onDispose('sessionHost', () => sessionHost.dispose())

  // 每个会话一个 store；同一进程里共用实例，避免重复打开。
  const stores = new Map<string, EventStore>()
  const storeFor = (sessionId: string): EventStore => {
    let store = stores.get(sessionId)
    if (!store) {
      store = new EventStore(sessionFile(config.profile.dataRoot, sessionId), {
        segmentMaxBytes: 8 * 1024 * 1024,
      })
      stores.set(sessionId, store)
      memoryLog?.attach(sessionId, store)
    }
    return store
  }
  container.register('sessionStore', storeFor)

  // createSession 与首次落盘之间暂存溯源，避免为了写一行元数据提前建文件。
  const pendingProvenance = new Map<string, CreateSessionInput>()

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

  let joinScheduler: SessionJoinScheduler | undefined

  const repaired = new Set<string>()
  const ensureSession = (sessionId: string): EventStore => {
    if (sessionLifecycle.stateOf(sessionId) === 'deleted') {
      throw new Error(`session is deleted: ${sessionId}`)
    }
    const store = storeFor(sessionId)
    if (!store.hasAnyEvents()) {
      const provenance = pendingProvenance.get(sessionId)
      pendingProvenance.delete(sessionId)
      writerFor(sessionId).append({
        stream: sessionStream(sessionId),
        actor: 'system',
        type: 'session.created',
        payload: {
          sessionId,
          createdAt: now().toISOString(),
          formatVersion: 2,
          seqBase: 0,
          createdBy: provenance?.createdBy ?? 'user',
          ...(provenance?.createdFrom ? { createdFrom: provenance.createdFrom } : {}),
          ...(provenance?.agentId ? { agentId: provenance.agentId } : {}),
          ...(provenance?.reason ? { reason: provenance.reason } : {}),
        },
      })
      return store
    }

    // 第一次真正打开这个会话时修崩溃尾巴；之后同一进程不再重复扫。
    if (!repaired.has(sessionId)) {
      repaired.add(sessionId)
      const writer = writerFor(sessionId)
      repairInterruptedSession(store, writer)
      settleInterruptedApprovals(store, writer)
      joinScheduler?.restore(sessionId)
      // 上次进程崩溃时留下的 wake 消息：它们还没进过任何完成轮。
      if (pendingWakeMessages(store.read()).length > 0) queueInboxWake(sessionId)
    }
    return store
  }

  // 模型：只注册配置里真实存在的来源；内置模板只在添加时参考。
  const models = new Registry()
  for (const provider of config.providers) models.register(provider)
  container.register('models', models)

  const providerOverrides = new Map<string, {
    apiKey?: string
    baseUrls?: Record<string, string>
  }>()
  const balanceService = new ModelBalanceService()
  const providerBaseUrlOf = (provider: ProviderConfig, family?: string): string => {
    const target = family ?? provider.defaultChatEndpoint ?? Object.keys(provider.endpoints)[0]
    if (!target) return ''
    return providerOverrides.get(provider.id)?.baseUrls?.[target]
      ?? provider.endpoints[target]?.baseUrl
      ?? ''
  }
  const modelOverrides = new Map<string, {
    contextWindow?: number | null
    maxOutputTokens?: number | null
    pricing?: ModelPricing | null
  }>()
  const modelKey = (providerId: string, modelId: string): string => `${providerId}\u0000${modelId}`

  const applyModelOverrides = (model: ModelCard, providerId: string): ModelCard => {
    const override = modelOverrides.get(modelKey(providerId, model.id))
    if (!override) return model
    const {
      contextWindow: modelContext,
      maxOutputTokens: modelMaxOutput,
      pricing: modelPricing,
      ...rest
    } = model
    const contextWindow = override.contextWindow === undefined
      ? modelContext
      : override.contextWindow
    const maxOutputTokens = override.maxOutputTokens === undefined
      ? modelMaxOutput
      : override.maxOutputTokens
    const pricing = override.pricing === undefined ? modelPricing : override.pricing
    return {
      ...rest,
      ...(contextWindow !== undefined && contextWindow !== null ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined && maxOutputTokens !== null ? { maxOutputTokens } : {}),
      ...(pricing !== undefined && pricing !== null ? { pricing } : {}),
    }
  }

  const resolveModelWithOverrides = (providerId: string, modelId: string): ResolvedModel => {
    const resolved = models.resolve(providerId, modelId)
    const override = providerOverrides.get(providerId)
    const baseUrl = override?.baseUrls?.[resolved.family ?? '']
    return {
      ...resolved,
      model: applyModelOverrides(resolved.model, providerId),
      provider: override?.apiKey
        ? { ...resolved.provider, apiKey: override.apiKey }
        : resolved.provider,
      endpoint: baseUrl
        ? { ...resolved.endpoint, baseUrl }
        : resolved.endpoint,
    }
  }

  const agentSettings = new AgentSettingsStore(config.profile.dataRoot, { now })

  const writeConfigFile = async (mutate: (raw: RawConfigFile) => void): Promise<void> => {
    if (!options.configPath) return
    const configPath = options.configPath
    await withFileLock(configPath, () => {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawConfigFile
      mutate(raw)
      const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
      renameSync(temp, configPath)
    }, { timeoutMs: 5_000 })
  }

  const updateService = new UpdateService({
    layout: resolveUpdateLayout({
      dataRoot: config.profile.dataRoot,
      currentVersion: IF_VERSION,
    }),
    ...(config.update?.manifestUrl ? { manifestUrl: config.update.manifestUrl } : {}),
    now,
  })
  container.onDispose('update', () => updateService.dispose())

  const providerToRaw = (provider: ProviderConfig, apiKey?: string): RawProviderEntry => ({
    id: provider.id,
    name: provider.name,
    ...(provider.description ? { description: provider.description } : {}),
    ...(provider.apiKeys?.length
      ? {
        apiKeys: provider.apiKeys.map(entry => ({
          id: entry.id,
          ...(entry.name ? { name: entry.name } : {}),
          key: entry.key,
          ...(entry.isEnabled !== undefined ? { isEnabled: entry.isEnabled } : {}),
        })),
      }
      : {}),
    ...((apiKey ?? provider.apiKey) ? { apiKey: apiKey ?? provider.apiKey } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
    ...(provider.defaultChatEndpoint
      ? { defaultChatEndpoint: provider.defaultChatEndpoint }
      : {}),
    endpoints: Object.fromEntries(Object.entries(provider.endpoints).map(([family, endpoint]) => [
      family,
      {
        baseUrl: endpoint.baseUrl,
        ...(endpoint.adapterFamily ? { adapterFamily: endpoint.adapterFamily } : {}),
        ...(endpoint.headers ? { headers: { ...endpoint.headers } } : {}),
        ...(endpoint.reasoningFormat ? { reasoningFormat: endpoint.reasoningFormat } : {}),
      },
    ])),
    models: provider.models.map(model => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.apiModelId ? { apiModelId: model.apiModelId } : {}),
      ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
      ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
      ...(model.outputModalities ? { outputModalities: [...model.outputModalities] } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(model.pricing ? { pricing: model.pricing } : {}),
      ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
    })),
  })

  const ensureRawProvider = (
    raw: RawConfigFile,
    provider: ProviderConfig,
  ): RawProviderEntry => {
    raw.providers ??= []
    let entry = raw.providers.find(item => item.id === provider.id)
    if (!entry) {
      entry = providerToRaw(provider)
      raw.providers.push(entry)
    }
    return entry
  }

  const previewApiKey = (key: string): string => {
    const trimmed = key.trim()
    if (trimmed.length <= 8) return '••••'
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
  }

  interface KeyEntryView extends ApiKeyConfig {
    readonly legacy?: boolean
  }

  const keyEntriesOf = (provider: ProviderConfig): KeyEntryView[] => {
    const entries: KeyEntryView[] = (provider.apiKeys ?? [])
      .filter(entry => entry.key.trim().length > 0)
      .map(entry => ({ ...entry }))
    const legacy = providerOverrides.get(provider.id)?.apiKey ?? provider.apiKey
    if (legacy?.trim() && !entries.some(entry => entry.key === legacy)) {
      entries.push({
        id: 'legacy',
        name: '旧单密钥',
        key: legacy,
        isEnabled: true,
        legacy: true,
      })
    }
    return entries
  }

  const modelConfigView = (): ModelConfigView => ({
    timeZone: config.profile.timeZone,
    providers: models.list().map((provider: ProviderConfig) => {
      const override = providerOverrides.get(provider.id)
      const endpointFamilies = Object.keys(provider.endpoints)
      const endpointFamily = provider.defaultChatEndpoint
        ?? endpointFamilies[0]
        ?? ''
      const apiKeys = keyEntriesOf(provider).map(entry => ({
        id: entry.id,
        ...(entry.name ? { name: entry.name } : {}),
        preview: previewApiKey(entry.key),
        isEnabled: entry.isEnabled !== false,
        ...(entry.legacy ? { legacy: true } : {}),
      }))
      const envKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined
      return {
        id: provider.id,
        name: provider.name,
        endpointFamily,
        endpointFamilies,
        endpoints: endpointFamilies.map(family => ({
          family,
          baseUrl: override?.baseUrls?.[family]
            ?? provider.endpoints[family]?.baseUrl
            ?? '',
        })),
        baseUrl: override?.baseUrls?.[endpointFamily]
          ?? provider.endpoints[endpointFamily]?.baseUrl
          ?? '',
        models: provider.models.map(model => {
          const merged = applyModelOverrides(model, provider.id)
          return {
            id: merged.id,
            ...(merged.name ? { name: merged.name } : {}),
            ...(merged.contextWindow !== undefined
              ? { contextWindow: merged.contextWindow }
              : {}),
            ...(merged.maxOutputTokens !== undefined
              ? { maxOutputTokens: merged.maxOutputTokens }
              : {}),
            ...(merged.pricing ? { pricing: merged.pricing } : {}),
            enabled: merged.enabled !== false,
          }
        }),
        apiKeys,
        hasApiKey: apiKeys.some(entry => entry.isEnabled) || Boolean(envKey),
        balanceSupported: balanceService.supports(provider, providerBaseUrlOf(provider)),
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
        enabled: provider.enabled !== false,
        removable: true,
      }
    }),
  })

  const saveModelConfig = async (input: ModelConfigUpdate): Promise<ModelConfigView> => {
    const provider = models.get(input.provider)
    const requestedFormat = input.format?.trim()
    const family = requestedFormat
      || provider.defaultChatEndpoint
      || Object.keys(provider.endpoints)[0]
      || ''
    if (!family) throw new Error(`config provider has no endpoint: ${input.provider}`)
    if (requestedFormat && !provider.endpoints[requestedFormat]) {
      throw new Error(`provider ${input.provider} has no endpoint: ${requestedFormat}`)
    }

    const current = providerOverrides.get(input.provider) ?? {}
    const next = {
      ...current,
      ...(current.baseUrls ? { baseUrls: { ...current.baseUrls } } : {}),
    }
    if (input.apiKey !== undefined && input.apiKey.trim()) next.apiKey = input.apiKey.trim()
    if (input.baseUrl !== undefined && input.baseUrl.trim()) {
      next.baseUrls = { ...(next.baseUrls ?? {}), [family]: input.baseUrl.trim() }
    }
    providerOverrides.set(provider.id, next)

    await writeConfigFile(raw => {
      const rawProvider = ensureRawProvider(raw, provider)
      if (next.apiKey) rawProvider.apiKey = next.apiKey
      if (input.enabled !== undefined) rawProvider.enabled = input.enabled
      const baseUrl = next.baseUrls?.[family]
      if (baseUrl) {
        rawProvider.endpoints ??= {}
        const endpoint = rawProvider.endpoints[family]
          ?? (rawProvider.endpoints[family] = {})
        if (!endpoint.adapterFamily) {
          endpoint.adapterFamily = provider.endpoints[family]?.adapterFamily
            ?? family
        }
        endpoint.baseUrl = baseUrl
      }
    })
    providerOverrides.set(provider.id, next)
    if (input.enabled !== undefined) models.setEnabled(provider.id, input.enabled)
    return modelConfigView()
  }

  const saveModelCard = async (input: ModelCardUpdate): Promise<ModelConfigView> => {
    const provider = models.get(input.provider)
    if (!provider.models.some(model => model.id === input.model)) {
      throw new Error(`unknown model: ${input.provider}/${input.model}`)
    }
    if (input.contextWindow !== undefined && input.contextWindow !== null) {
      if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) {
        throw new Error('contextWindow must be a positive number')
      }
    }
    if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
      if (!Number.isFinite(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
        throw new Error('maxOutputTokens must be a positive number')
      }
    }
    if (input.pricing) validatePricing(input.pricing)

    const key = modelKey(input.provider, input.model)
    const current = modelOverrides.get(key) ?? {}

    await writeConfigFile(raw => {
      const rawProvider = ensureRawProvider(raw, provider)
      rawProvider.models ??= []
      let rawModel = rawProvider.models.find(model => model.id === input.model)
      if (!rawModel) {
        rawModel = { id: input.model }
        rawProvider.models.push(rawModel)
      }
      if (input.contextWindow !== undefined) {
        if (input.contextWindow === null) delete rawModel.contextWindow
        else rawModel.contextWindow = input.contextWindow
      }
      if (input.maxOutputTokens !== undefined) {
        if (input.maxOutputTokens === null) delete rawModel.maxOutputTokens
        else rawModel.maxOutputTokens = input.maxOutputTokens
      }
      if (input.pricing !== undefined) {
        if (input.pricing === null) delete rawModel.pricing
        else rawModel.pricing = input.pricing
      }
      if (input.enabled !== undefined) rawModel.enabled = input.enabled
    })
    modelOverrides.set(key, {
      ...current,
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
      ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
    })
    if (input.enabled !== undefined) models.setModelEnabled(provider.id, input.model, input.enabled)
    return modelConfigView()
  }

  const addModelProvider = async (input: ModelProviderInput): Promise<ModelConfigView> => {
    const id = input.id.trim()
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
      throw new Error('provider id must match ^[a-z][a-z0-9_-]*$')
    }
    const name = input.name.trim()
    if (!name) throw new Error('provider name is required')
    const baseUrl = input.baseUrl.trim()
    if (!baseUrl) throw new Error('baseUrl is required')
    let format = input.format?.trim() || 'openai-chat-completions'
    try {
      format = normalizeEndpointFamily(format)
    } catch {
      throw new Error(`不支持的端点格式：${format}`)
    }
    if (models.list().some(provider => provider.id === id)) {
      throw new Error(`provider already exists: ${id}`)
    }

    const endpoints: Record<string, { adapterFamily: string; baseUrl: string }> = {}
    for (const [key, value] of Object.entries(input.endpoints ?? {})) {
      if (typeof value?.baseUrl !== 'string' || !value.baseUrl.trim()) continue
      let family = key
      try {
        family = normalizeEndpointFamily(key)
      } catch {
        throw new Error(`不支持的端点格式：${key}`)
      }
      endpoints[family] = { adapterFamily: family, baseUrl: value.baseUrl.trim() }
    }
    // 默认格式的 baseUrl 以表单里那一栏为准。
    endpoints[format] = { adapterFamily: format, baseUrl }

    const seen = new Set<string>()
    const modelCards: ModelCard[] = (input.models ?? []).map(model => {
      const modelId = model.id.trim()
      if (!modelId) throw new Error('model id is required')
      if (seen.has(modelId)) throw new Error(`duplicate model: ${modelId}`)
      seen.add(modelId)
      if (model.contextWindow !== undefined
        && (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0)) {
        throw new Error(`invalid contextWindow for ${modelId}`)
      }
      if (model.maxOutputTokens !== undefined
        && (!Number.isFinite(model.maxOutputTokens) || model.maxOutputTokens <= 0)) {
        throw new Error(`invalid maxOutputTokens for ${modelId}`)
      }
      return {
        id: modelId,
        ...(model.name?.trim() ? { name: model.name.trim() } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens !== undefined
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
      }
    })

    const apiKey = input.apiKey?.trim()
    const apiKeys: ApiKeyConfig[] | undefined = apiKey
      ? [{
        id: `key-${randomUUID().slice(0, 8)}`,
        ...(input.apiKeyName?.trim() ? { name: input.apiKeyName.trim() } : {}),
        key: apiKey,
        isEnabled: true,
      }]
      : undefined
    const provider: ProviderConfig = {
      id,
      name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(apiKeys ? { apiKeys } : {}),
      ...(input.apiKeyEnv?.trim() ? { apiKeyEnv: input.apiKeyEnv.trim() } : {}),
      defaultChatEndpoint: format as ProviderConfig['defaultChatEndpoint'],
      endpoints,
      models: modelCards,
    }

    await writeConfigFile(raw => {
      raw.providers ??= []
      if (raw.providers.some(item => item.id === id)) {
        throw new Error(`provider already exists: ${id}`)
      }
      raw.providers.push(providerToRaw(provider))
    })
    models.register(provider)
    providerOverrides.set(id, {
      baseUrls: Object.fromEntries(
        Object.entries(endpoints).map(([family, endpoint]) => [family, endpoint.baseUrl]),
      ),
    })
    return modelConfigView()
  }

  const persistApiKeys = async (
    provider: ProviderConfig,
    keys: readonly ApiKeyConfig[],
  ): Promise<void> => {
    await writeConfigFile(raw => {
      const rawProvider = ensureRawProvider(raw, provider)
      if (keys.length === 0) {
        delete rawProvider.apiKeys
        return
      }
      rawProvider.apiKeys = keys.map(entry => ({
        id: entry.id,
        ...(entry.name ? { name: entry.name } : {}),
        key: entry.key,
        ...(entry.isEnabled !== undefined ? { isEnabled: entry.isEnabled } : {}),
      }))
    })
    models.setApiKeys(provider.id, keys.length > 0 ? keys : undefined)
  }

  const addModelApiKey = async (input: ModelApiKeyInput): Promise<ModelConfigView> => {
    const provider = models.get(input.provider)
    const key = input.key.trim()
    if (!key) throw new Error('API key is required')
    const keys = [...(provider.apiKeys ?? [])]
    if (keyEntriesOf(provider).some(entry => entry.key === key)) {
      throw new Error('这个密钥已经存在')
    }
    keys.push({
      id: `key-${randomUUID().slice(0, 8)}`,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      key,
      isEnabled: input.isEnabled ?? true,
    })
    await persistApiKeys(provider, keys)
    return modelConfigView()
  }

  const clearLegacyApiKey = async (provider: ProviderConfig): Promise<void> => {
    const current = providerOverrides.get(provider.id)
    if (current?.apiKey !== undefined) {
      const { apiKey: _removed, ...rest } = current
      if (Object.keys(rest).length > 0) providerOverrides.set(provider.id, rest)
      else providerOverrides.delete(provider.id)
    }
    await writeConfigFile(raw => {
      const rawProvider = ensureRawProvider(raw, provider)
      delete rawProvider.apiKey
    })
    models.setLegacyApiKey(provider.id, undefined)
  }

  const removeModelApiKey = async (input: ModelApiKeyRemoveInput): Promise<ModelConfigView> => {
    const provider = models.get(input.provider)
    const target = keyEntriesOf(provider).find(entry => entry.id === input.keyId)
    if (!target) throw new Error(`unknown api key: ${input.keyId}`)

    if (target.legacy) {
      await clearLegacyApiKey(provider)
      return modelConfigView()
    }

    const keys = (provider.apiKeys ?? []).filter(entry => entry.id !== input.keyId)
    await persistApiKeys(provider, keys)
    return modelConfigView()
  }

  const updateModelApiKey = async (
    input: ModelApiKeyUpdateInput,
  ): Promise<ModelConfigView> => {
    if (input.name === undefined && input.isEnabled === undefined) {
      throw new Error('nothing to update')
    }
    const provider = models.get(input.provider)
    const target = keyEntriesOf(provider).find(entry => entry.id === input.keyId)
    if (!target) throw new Error(`unknown api key: ${input.keyId}`)

    if (target.legacy) {
      // 改旧单密钥时顺手迁进多 key 列表，之后就能像普通 key 一样管理。
      const name = input.name === undefined ? '旧单密钥' : input.name.trim()
      const migrated: ApiKeyConfig = {
        id: `key-${randomUUID().slice(0, 8)}`,
        ...(name ? { name } : {}),
        key: target.key,
        isEnabled: input.isEnabled ?? true,
      }
      await persistApiKeys(provider, [...(provider.apiKeys ?? []), migrated])
      await clearLegacyApiKey(provider)
      return modelConfigView()
    }

    const keys = (provider.apiKeys ?? []).map(entry => {
      if (entry.id !== input.keyId) return entry
      if (input.name === undefined) {
        return { ...entry, isEnabled: input.isEnabled }
      }
      const { name: _old, ...rest } = entry
      return {
        ...rest,
        ...(input.name.trim() ? { name: input.name.trim() } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
      }
    })
    await persistApiKeys(provider, keys)
    return modelConfigView()
  }

  const revealModelApiKey = (input: ModelApiKeyRemoveInput): string => {
    const provider = models.get(input.provider)
    const target = keyEntriesOf(provider).find(entry => entry.id === input.keyId)
    if (!target) throw new Error(`unknown api key: ${input.keyId}`)
    return target.key
  }

  const modelBalance = async (input: ModelBalanceInput): Promise<ModelBalance> => {
    let provider: ProviderConfig
    try {
      provider = models.get(input.provider)
    } catch (error) {
      throw new BalanceInputError(error instanceof Error ? error.message : String(error))
    }
    const target = keyEntriesOf(provider).find(entry => entry.id === input.keyId)
    if (!target) throw new BalanceInputError(`unknown api key: ${input.keyId}`)
    if (target.isEnabled === false) throw new BalanceInputError('api key is disabled')
    const baseUrl = providerBaseUrlOf(provider)
    if (!baseUrl) throw new BalanceInputError(`provider ${provider.id} has no baseUrl`)
    return balanceService.query({
      provider,
      keyId: target.id,
      apiKey: target.key,
      baseUrl,
      ...(input.refresh ? { force: true } : {}),
    })
  }

  const addProviderModels = async (
    input: ModelProviderModelsInput,
  ): Promise<ModelConfigView> => {
    const provider = models.get(input.provider)
    const existing = new Set(provider.models.map(model => model.id))
    const seen = new Set<string>()
    const cards: ModelCard[] = []
    for (const item of input.models) {
      const modelId = item.id.trim()
      if (!modelId) throw new Error('model id is required')
      if (existing.has(modelId) || seen.has(modelId)) continue
      seen.add(modelId)
      if (item.contextWindow !== undefined
        && (!Number.isFinite(item.contextWindow) || item.contextWindow <= 0)) {
        throw new Error(`invalid contextWindow for ${modelId}`)
      }
      if (item.maxOutputTokens !== undefined
        && (!Number.isFinite(item.maxOutputTokens) || item.maxOutputTokens <= 0)) {
        throw new Error(`invalid maxOutputTokens for ${modelId}`)
      }
      cards.push({
        id: modelId,
        ...(item.name?.trim() ? { name: item.name.trim() } : {}),
        ...(item.contextWindow !== undefined ? { contextWindow: item.contextWindow } : {}),
        ...(item.maxOutputTokens !== undefined
          ? { maxOutputTokens: item.maxOutputTokens }
          : {}),
      })
    }
    if (cards.length === 0) return modelConfigView()

    await writeConfigFile(raw => {
      const rawProvider = ensureRawProvider(raw, provider)
      rawProvider.models ??= []
      for (const card of cards) {
        if (rawProvider.models.some(model => model.id === card.id)) continue
        rawProvider.models.push({
          id: card.id,
          ...(card.name ? { name: card.name } : {}),
          ...(card.contextWindow !== undefined ? { contextWindow: card.contextWindow } : {}),
          ...(card.maxOutputTokens !== undefined
            ? { maxOutputTokens: card.maxOutputTokens }
            : {}),
        })
      }
    })
    models.addModels(provider.id, cards)
    return modelConfigView()
  }

  const removeModelProvider = async (id: string): Promise<ModelConfigView> => {
    models.get(id)
    for (const settings of agentSettings.list()) {
      if (settings.models?.main?.provider === id) {
        throw new Error(`agent ${settings.agentId} 正在使用这个服务商，先改掉它的主模型`)
      }
      if ((settings.models?.subagents ?? []).some(model => model.provider === id)) {
        throw new Error(`agent ${settings.agentId} 的子 agent 正在使用这个服务商`)
      }
    }
    await writeConfigFile(raw => {
      raw.providers = (raw.providers ?? []).filter(item => item.id !== id)
    })
    models.remove(id)
    providerOverrides.delete(id)
    return modelConfigView()
  }

  const probeEndpointRequest = (
    family: string,
    baseUrl: string,
    apiKey: string | undefined,
  ): { url: string; headers: Record<string, string> } => {
    const endpointFormat = normalizeEndpointFamily(family)
    // Chat Completions 与对话请求同一约定：baseUrl 自带版本段。
    const url = endpointFormat === 'openai-chat-completions'
      ? `${baseUrl.replace(/\/+$/, '')}/models`
      : apiUrl(
        baseUrl,
        '/models',
        endpointFormat === 'google-generate-content' ? 'v1beta' : 'v1',
      )
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(endpointFormat === 'anthropic-messages'
        ? {
          'anthropic-version': '2023-06-01',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        }
        : endpointFormat === 'google-generate-content'
          ? (apiKey ? { 'x-goog-api-key': apiKey } : {})
          : (apiKey ? { authorization: `Bearer ${apiKey}` } : {})),
    }
    return { url, headers }
  }

  const probeModelProvider = async (
    input: ModelProbeInput,
  ): Promise<{ models: readonly string[] }> => {
    const provider = models.get(input.provider)
    const override = providerOverrides.get(provider.id)
    const requestedFormat = input.format?.trim()
    if (requestedFormat && !provider.endpoints[requestedFormat]) {
      throw new Error(`provider ${provider.id} has no endpoint: ${requestedFormat}`)
    }
    const families: string[] = []
    const addFamily = (family: string | undefined): void => {
      if (!family || !provider.endpoints[family] || families.includes(family)) return
      families.push(family)
    }
    addFamily(requestedFormat)
    addFamily(provider.defaultChatEndpoint)
    for (const family of Object.keys(provider.endpoints)) addFamily(family)
    if (families.length === 0) throw new Error(`provider ${provider.id} has no endpoint`)

    const apiKey = input.apiKey?.trim()
      || models.resolveApiKeys(provider)[0]
    const errors: string[] = []
    const seen = new Set<string>()
    const deadline = Date.now() + 20_000

    for (const family of families) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        errors.push('总超时（20 秒）')
        break
      }
      const baseUrl = (family === families[0] ? input.baseUrl?.trim() : undefined)
        || override?.baseUrls?.[family]
        || provider.endpoints[family]?.baseUrl
      if (!baseUrl) {
        errors.push(`${family}: 没有 baseUrl`)
        continue
      }
      let request: { url: string; headers: Record<string, string> }
      try {
        request = probeEndpointRequest(family, baseUrl, apiKey)
      } catch (error) {
        errors.push(`${family}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const dedupeKey = `${request.url}\u0000${
        request.headers.authorization
          ?? request.headers['x-api-key']
          ?? request.headers['x-goog-api-key']
          ?? ''
      }`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1_000, Math.min(10_000, deadline - Date.now())),
      )
      try {
        const response = await fetch(request.url, {
          headers: request.headers,
          signal: controller.signal,
        })
        const text = await response.text()
        if (!response.ok) {
          errors.push(`${family}: HTTP ${response.status}: ${text.slice(0, 200)}`)
          continue
        }
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          errors.push(`${family}: 返回不是 JSON`)
          continue
        }
        const rows: unknown[] = Array.isArray(body)
          ? body
          : (typeof body === 'object' && body !== null
            && Array.isArray((body as { data?: unknown }).data))
            ? (body as { data: unknown[] }).data
            : (typeof body === 'object' && body !== null
              && Array.isArray((body as { models?: unknown }).models))
              ? (body as { models: unknown[] }).models
              : []
        const ids = rows.map(row => {
          if (typeof row === 'string') return row
          if (typeof row !== 'object' || row === null) return ''
          const record = row as { id?: unknown; name?: unknown }
          const value = typeof record.id === 'string'
            ? record.id
            : (typeof record.name === 'string' ? record.name : '')
          return value.replace(/^models\//, '')
        }).filter(id => id.length > 0)
        const unique = [...new Set(ids)].sort()
        if (unique.length === 0) {
          errors.push(`${family}: 返回里没有模型 id`)
          continue
        }
        return { models: unique }
      } catch (error) {
        errors.push(
          `${family}: ${error instanceof Error && error.name === 'AbortError'
            ? '超时'
            : error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        clearTimeout(timer)
      }
    }

    throw new Error(`读取模型列表失败：\n${errors.map(item => `- ${item}`).join('\n')}`)
  }

  // 全文库与写时卸载：工具结果落事件前经过它。
  const blobs = new BlobStore(join(config.profile.dataRoot, 'blobs'))
  container.register('blobs', blobs)
  const fileSpill = new FileSpillStore(join(config.profile.dataRoot, 'spill'))
  const spill = new SpillPolicy(fileSpill)
  const offload = new OffloadPolicy(blobs, mergeOffload(config.patch?.offload))

  // 工具：只读默认开，危险工具看名单。
  const tools = new ToolRegistry()
  for (const tool of SAFE_TOOLS) tools.register(tool, 'builtin')
  tools.register(createRecallTool(storeFor, {
    ...(memoryRoot ? { memoryLogRoot: memoryRoot } : {}),
    blobs,
    spill: fileSpill,
    agentStore: storeFor,
  }), 'builtin')

  const mainAgentId = defaultAgentId
  const manifestStore = memoryRoot
    ? new AgentManifestStore(memoryRoot)
    : undefined
  const agentManifest = (() => {
    if (!manifestStore) return undefined
    try {
      return manifestStore.read(mainAgentId)
    } catch {
      return undefined
    }
  })()

  const agentIdOfSession = (sessionId: string): string =>
    sessionInfo(config.profile.dataRoot, sessionId)?.agentId ?? mainAgentId

  const agentSettingsOf = (agentId: string): AgentSettings | undefined => {
    try {
      return agentSettings.read(agentId)
    } catch (error) {
      throw new AgentModelInvalidError(
        agentId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  const resolveAgentModel = (agentId: string): ResolvedModel => {
    const settings = agentSettingsOf(agentId)
    const choice = settings?.models?.main
    if (!choice) throw new AgentModelMissingError(agentId)
    try {
      return resolveModelWithOverrides(choice.provider, choice.model)
    } catch (error) {
      throw new AgentModelInvalidError(
        agentId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  const manifestOf = (agentId: string): AgentManifest | undefined => {
    if (!manifestStore) return undefined
    try {
      return manifestStore.read(agentId)
    } catch {
      return undefined
    }
  }

  const settingsOfQuietly = (agentId: string): AgentSettings | undefined => {
    try {
      return agentSettings.read(agentId)
    } catch {
      return undefined
    }
  }

  const sessionsOfAgent = (agentId: string): SessionInfo[] =>
    listSessions(config.profile.dataRoot, {
      lifecycle: id => sessionLifecycle.stateOf(id),
      includeArchived: true,
      includeDeleted: false,
    }).filter(session => (session.agentId ?? mainAgentId) === agentId)

  /** 一次扫描算全部 agent 的会话数；列表页不要按 agent 重扫。 */
  const sessionCounts = (): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const session of listSessions(config.profile.dataRoot, {
      lifecycle: id => sessionLifecycle.stateOf(id),
      includeArchived: true,
      includeDeleted: false,
    })) {
      const agentId = session.agentId ?? mainAgentId
      counts.set(agentId, (counts.get(agentId) ?? 0) + 1)
    }
    return counts
  }

  /** 人格文件变更后，给该 agent 名下的会话留一条一次性 system delta。 */
  const notifyPersonaChanged = (agentId: string, label: string): void => {
    let targetSessions: SessionInfo[] = []
    try {
      targetSessions = sessionsOfAgent(agentId)
    } catch {
      // 会话目录扫描失败不能让人格文件保存看起来失败。
    }
    for (const session of targetSessions) {
      if (session.lifecycle === 'deleted') continue
      try {
        const writer = writerFor(session.id)
        writer.append({
          stream: sessionStream(session.id),
          actor: 'system',
          type: 'message.system',
          payload: {
            text: `人格文件已更新：${label}。请以最新人格文件为准；如果本会话早前的自我介绍与它冲突，以最新人格为准。`,
            mark: 'injection',
          },
        })
        writer.flush()
      } catch {
        // 单个会话写失败不影响人格文件保存；下一轮稳定身份段仍会重新读取。
      }
    }
  }

  const agentSummaryOf = (
    agentId: string,
    counts?: ReadonlyMap<string, number>,
  ): AgentSummary => {
    const manifest = manifestOf(agentId)
    const settings = settingsOfQuietly(agentId)
    const model = settings?.models?.main
    let modelConfigured = false
    let prefillSupported = false
    if (model) {
      try {
        const resolved = resolveModelWithOverrides(model.provider, model.model)
        modelConfigured = true
        prefillSupported = supportsAssistantPrefill(resolved)
      } catch {
        modelConfigured = false
      }
    }
    const sessionCount = counts?.get(agentId) ?? sessionsOfAgent(agentId).length
    const blockedReason = agentId === mainAgentId
      ? '默认主 agent 不能删除；要换身份请新建 agent 并改默认配置。'
      : sessionCount > 0
        ? `还有 ${sessionCount} 个未删除的会话（含归档），先删除或彻底删除这些会话。`
        : undefined
    return {
      id: agentId,
      name: manifest?.name ?? agentId,
      hasManifest: Boolean(manifest),
      ...(model ? { model } : {}),
      modelConfigured,
      prefillSupported,
      subagentModels: settings?.models?.subagents ?? [],
      ...(settings?.subagentPresets !== undefined
        ? { subagentPresets: settings.subagentPresets }
        : {}),
      availablePresets: presets.list().map(preset => ({
        id: preset.id,
        description: preset.description,
      })),
      tools: {
        ...(settings?.tools?.allow !== undefined ? { allow: settings.tools.allow } : {}),
        ...(settings?.tools?.approval ? { approval: settings.tools.approval } : {}),
      },
      sessionCount,
      deletable: blockedReason === undefined,
      ...(blockedReason ? { deleteBlockedReason: blockedReason } : {}),
    }
  }

  const subagentPolicyOf = (sessionId: string): SubagentPolicy | undefined => {
    const agentId = agentIdOfSession(sessionId)
    const settings = settingsOfQuietly(agentId)
    if (!settings) return undefined
    const mainModel = settings.models?.main
    const models = settings.models?.subagents?.length
      ? settings.models.subagents
      : mainModel ? [mainModel] : []
    return {
      models,
      ...(mainModel ? { mainModel } : {}),
      ...(settings.subagentPresets !== undefined ? { presets: settings.subagentPresets } : {}),
      ...(settings.tools?.allow !== undefined ? { toolAllow: settings.tools.allow } : {}),
    }
  }

  const toolViewsOf = (agentId?: string): ToolView[] => {
    const settings = agentId ? settingsOfQuietly(agentId) : undefined
    const allow = settings?.tools?.allow !== undefined
      ? new Set(settings.tools.allow)
      : undefined
    const overrides = settings?.tools?.approval
    return tools.list({ includeDisabled: true }).map(descriptor => {
      const tool = tools.get(descriptor.name)
      const agentApproval = overrides?.[descriptor.name]
      return {
        name: descriptor.name,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        source: descriptor.source,
        enabled: descriptor.enabled,
        approval: descriptor.approval,
        dangerous: Boolean(tool?.meta?.dangerous),
        readOnly: Boolean(tool?.meta?.readOnly),
        // 插件工具没有显式 allow 时默认不给 agent；其它工具沿用旧行为。
        agentAllowed: allow ? allow.has(descriptor.name) : descriptor.source !== 'plugin',
        ...(agentApproval ? { agentApproval } : {}),
        effectiveApproval: agentApproval ?? descriptor.approval,
      }
    })
  }

  // 记忆工具：能力位由 session 决定；没有 memoryRoot 就不注册。
  const memoryCommitter = memoryRoot
    ? new MemoryCommitter(memoryRoot, {
      enabled: config.patch?.runtime?.memory?.autoCommit === true,
    })
    : undefined
  let memorySearchIndex: MemorySearchIndex | undefined
  let memoryPush: MemoryPushService | undefined
  let memorySummaryWorker: MemorySummaryWorker | undefined
  const memoryStore = memoryRoot
    ? new MemoryStore(memoryRoot, {
      timeZone: config.profile.timeZone,
      libraryLock: join(memoryRoot, '.state', 'library.lock'),
      onWrite: target => {
        memoryCommitter?.markDirty(target)
        memorySearchIndex?.markDirty()
        semanticMemoryIndex?.markDirty()
        memoryPush?.invalidate()
        if (target.startsWith('detail:')) memorySummaryWorker?.enqueue(target)
        try {
          writeIndex({ memoryRoot })
        } catch {
          // 索引更新失败不阻塞记忆写入。
        }
      },
    })
    : undefined
  if (memoryRoot && memoryStore) {
    memorySearchIndex = new MemorySearchIndex(memoryRoot, memoryStore)
    semanticMemoryIndex = new SemanticMemoryIndex(memoryRoot, memoryStore, embeddingService)
    if (embeddingService.isAvailable()) {
      void semanticMemoryIndex.build().catch(() => undefined)
    }
  }
  const memoryPolicyStore = memoryRoot
    ? new MemoryPolicyStore(memoryRoot, {
      agentIdFor: sessionId => sessionInfo(config.profile.dataRoot, sessionId)?.agentId
        ?? mainAgentId,
    })
    : undefined
  const summaryModel = (() => {
    try {
      return resolveAgentModel(mainAgentId)
    } catch {
      return undefined
    }
  })()
  const memorySummaries = memoryRoot && memoryStore
    ? new MemorySummaryStore({
      root: memoryRoot,
      store: memoryStore,
      ...(summaryModel
        ? { generator: new ModelSummaryGenerator({ model: summaryModel }) }
        : {}),
      onWrite: target => memoryCommitter?.markDirty(target),
    })
    : undefined
  if (memorySummaries) {
    memorySummaryWorker = new MemorySummaryWorker({ summaries: memorySummaries })
    memorySummaryWorker.start()
    container.onDispose('memorySummaryWorker', () => memorySummaryWorker?.stop())
  }
  const memorySelector = memoryStore && memorySummaries
    ? new HeuristicMemorySelector({
      store: memoryStore,
      summaries: memorySummaries,
      // memorySpaceAccess 在下面装配；这个回调跑轮次时才调用，不会提前触发。
      autoPushDirsFor: sessionId => memorySpaceAccess === undefined
        ? []
        : memorySpaceAccess.visibleSpaces(sessionId)
          .filter(space => memorySpaceAccess.canAutoPush(sessionId, space.id))
          .map(space => spaceDir(space)),
    })
    : undefined
  if (memoryPolicyStore && memorySelector) {
    memoryPush = new MemoryPushService({
      selector: memorySelector,
      policy: memoryPolicyStore,
      segmentKeyFor: sessionId => {
        const events = storeFor(sessionId).read()
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index]!.type === 'context.compacted') return events[index]!.id
        }
        return 'initial'
      },
    })
  }

  const memoryLibrary = memoryRoot && memoryStore
    ? new MemoryLibrary({
      root: memoryRoot,
      store: memoryStore,
      onChange: paths => {
        for (const path of paths) memoryCommitter?.markDirty(path)
        memorySearchIndex?.markDirty()
        semanticMemoryIndex?.markDirty()
        memoryPush?.invalidate()
        memorySummaryWorker?.enqueueAll()
        try {
          writeIndex({ memoryRoot })
        } catch {
          // 索引生成失败不阻塞结构操作。
        }
      },
      onDetailMove: moves => {
        for (const move of moves) memorySummaries?.move(move.from, move.to)
      },
      onDetailRemove: targets => {
        for (const target of targets) memorySummaries?.remove(target)
      },
      validateWrite: (path, text) => {
        if (path === 'policy.json') memoryPolicyStore?.validateText(text)
      },
      afterWrite: path => {
        if (path === 'policy.json') {
          memoryPolicyStore?.reload()
          memoryPush?.invalidate()
        }
      },
    })
    : undefined
  const memoryAccess = memoryStore
    ? new MemoryAccess(
      join(config.profile.dataRoot, 'memory-grants.json'),
      sessionId => sessionInfo(config.profile.dataRoot, sessionId),
    )
    : undefined
  const memorySpaces = memoryStore && memoryRoot
    ? new MemorySpaceStore(memoryRoot)
    : undefined
  const memorySpaceAccess = memoryStore && memorySpaces && memoryAccess
    ? new MemorySpaceAccess(
      memorySpaces,
      memoryAccess,
      sessionId => sessionInfo(config.profile.dataRoot, sessionId)?.agentId ?? mainAgentId,
    )
    : undefined
  const memoryProposals = memoryStore
    ? new MemoryProposalStore(
      memoryRoot!,
      now,
      memoryCommitter ? () => memoryCommitter.markDirty('proposals') : undefined,
    )
    : undefined
  const memoryIdentity = memoryStore
    ? agentManifest
      ? new ManifestIdentityStore(new AgentIdentityStore(
        memoryRoot!,
        mainAgentId,
        { manifest: agentManifest },
      ))
      : config.profile.agentDir
        ? new MemoryIdentityStore(config.profile.agentDir)
        : undefined
    : undefined
  if (memoryStore && memoryAccess && memoryProposals) {
    for (const tool of createMemoryTools({
      store: memoryStore,
      access: memoryAccess,
      proposals: memoryProposals,
      ...(memoryPolicyStore ? { policy: memoryPolicyStore } : {}),
      ...(memorySearchIndex ? { searchIndex: memorySearchIndex } : {}),
      ...(semanticMemoryIndex ? { semanticIndex: semanticMemoryIndex } : {}),
      ...(memorySpaces ? { spaces: memorySpaces } : {}),
      ...(memorySpaceAccess ? { spaceAccess: memorySpaceAccess } : {}),
    })) {
      tools.register(tool, 'builtin')
    }
    container.register('memoryStore', memoryStore)
    if (memoryLibrary) container.register('memoryLibrary', memoryLibrary)
    container.register('memoryAccess', memoryAccess)
    if (memorySpaces) container.register('memorySpaces', memorySpaces)
    if (memorySpaceAccess) container.register('memorySpaceAccess', memorySpaceAccess)
    container.register('memoryProposals', memoryProposals)
    if (memorySpaces && memoryRoot) {
      setImmediate(() => {
        void memorySpaces.migratePrivateDirs(join(memoryRoot, 'detail')).catch(() => undefined)
      })
    }
    if (memoryPolicyStore) container.register('memoryPolicy', memoryPolicyStore)
    if (memorySearchIndex) {
      container.register('memorySearch', memorySearchIndex)
      container.onDispose('memorySearch', () => memorySearchIndex?.close())
    }
    if (semanticMemoryIndex) {
      container.register('memorySemantic', semanticMemoryIndex)
      container.onDispose('memorySemantic', () => semanticMemoryIndex?.close())
    }
    if (memoryIdentity) container.register('memoryIdentity', memoryIdentity)
    if (memoryCommitter) {
      container.register('memoryCommitter', memoryCommitter)
      container.onDispose('memoryCommitter', () => memoryCommitter.flush())
    }
  }

  const dangerousEnabled = new Set(config.patch?.tools?.enabled ?? [])
  const disabledTools = new Set(config.patch?.tools?.disabled ?? [])
  for (const [name, tool] of Object.entries(DANGEROUS_TOOLS)) {
    tools.register(tool, 'builtin', {
      enabled: dangerousEnabled.has(name) && !disabledTools.has(name),
    })
  }
  container.register('tools', tools)

  // 插件 v0：内置示例 + 显式开启的 dev 目录。全部进程内，权限只是宿主 API 准入。
  const pluginRegistry = new PluginRegistry({
    dataRoot: config.profile.dataRoot,
    tools,
    builtins: [createExamplePlugin()],
    dev: config.patch?.plugins?.dev === true || process.env.IF_DEV_PLUGINS === '1',
    enabledTools: new Set(config.patch?.tools?.enabled ?? []),
    disabledTools: new Set(config.patch?.tools?.disabled ?? []),
    ...(config.patch?.tools?.approval ? { toolApproval: config.patch.tools.approval } : {}),
    ...(config.patch?.plugins?.dir ? { devDir: config.patch.plugins.dir } : {}),
  })
  container.register('plugins', pluginRegistry)
  container.onDispose('plugins', () => pluginRegistry.stop())
  void pluginRegistry.start().catch(error => {
    console.error('[plugin] start failed:', error)
  })

  // 预设：只从配置来，代码不写死模型名。
  const presets = new PresetRegistry()
  for (const preset of config.presets) presets.register(preset)
  container.register('presets', presets)

  const approvals = new InMemoryApprovalRegistry()
  approvals.audit = {
    asked: entry => {
      const writer = writerFor(entry.sessionId)
      writer.append({
        stream: sessionStream(entry.sessionId),
        actor: 'system',
        type: 'approval.asked',
        payload: {
          approvalId: entry.approvalId,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          input: entry.originalInput,
          ...(entry.reason ? { reason: entry.reason } : {}),
          createdAt: new Date().toISOString(),
        },
      })
      writer.flush()
    },
    decided: (entry, decision, source) => {
      const writer = writerFor(entry.sessionId)
      writer.append({
        stream: sessionStream(entry.sessionId),
        actor: 'system',
        type: 'approval.decided',
        payload: {
          approvalId: entry.approvalId,
          approved: decision.approved,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          source,
          resolvedAt: new Date().toISOString(),
        },
      })
      writer.flush()
    },
  }
  container.register('approvals', approvals)

  const pool = mergePool(config.patch?.agents)
  const compaction = mergeCompaction(config.patch?.compaction)
  const estimator = new TokenEstimator()

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
      offload,
      estimator,
      models,
      resolveModel: resolveModelWithOverrides,
      modelRetry,
      ...(fsPolicy ? { sandbox: fsPolicy } : {}),
      ...(networkPolicy ? { network: networkPolicy } : {}),
      riskGuard,
      ...(leases ? { leases } : {}),
      workspaceId,
      ...(modelGate ? { modelGate } : {}),
      ...(metrics ? { metrics } : {}),
    }),
    // 终态回送来源会话；正文自带分类标记，模型能认出这不是用户说的。
    deliver: (result, request) => {
      // 来源会话已归档/删除：不再往它里面写回送消息，结果留在 agent 流里。
      if (!sessionLifecycle.canMessage(request.source.session)) return
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
          stream: agentStream(result.id),
        },
      })
      writer.flush()
      joinScheduler?.onTurnCompleted(result.id, result.status)
    },
  })
  container.register('agents', agents)
  // 先停调度器：它还会往 store 写终态。
  container.onDispose('agents', () => agents.dispose())

  // 启动时把上次崩溃留下的孤儿 agent 流标成 interrupted，不自动重放。
  for (const run of listAgentRuns(config.profile.dataRoot)) {
    if (TERMINAL_AGENT_STATUS.has(run.status)) continue
    repairAgentStream(storeFor(run.id), writerFor(run.id))
  }

  // 派活与控制面放在 manager 之后注册：工具创建时要用到它。
  tools.register(createRequestAgentTool({
    manager: agents,
    presets,
    resolvePolicy: subagentPolicyOf,
  }), 'builtin')
  tools.register(modelListTool({
    presets,
    resolvePolicy: subagentPolicyOf,
  }), 'builtin')
  for (const tool of createAgentControlTools({ manager: agents })) {
    tools.register(tool, 'builtin')
  }

  // 上下文：请求头 + 身份/记忆 + 时间。记忆读不到就跳过。
  const sections: ContextSection[] = []
  if (config.profile.header) sections.push(staticSection('header', config.profile.header, 100))
  if (memoryRoot || config.profile.agentDir) {
    sections.push(sessionMemorySection('memory', sessionId => {
      const agentId = sessionInfo(config.profile.dataRoot, sessionId)?.agentId ?? mainAgentId
      return loadIdentitySources(
        config.profile.agentDir ?? '',
        memoryRoot,
        agentId,
      )
    }, 90))
  }
  if (memoryPush) {
    sections.push(memoryPushSection('jev-memory', memoryPush, 95))
  }
  if (memorySpaceAccess) {
    sections.push(memorySpacesSection('memory-spaces', memorySpaceAccess, 92))
  }
  sections.push(timeSection())

  const maxBytes = config.patch?.context?.maxBytes

  let disposed = false

  const runSessionTurn = async (input: ChatOptions, skipStartEvent = false): Promise<RunResult> => {
    if (!sessionLifecycle.canRun(input.sessionId)) {
      throw new Error(`session is not active: ${input.sessionId} (${sessionLifecycle.stateOf(input.sessionId)})`)
    }
    const store = ensureSession(input.sessionId)
    const writer = writerFor(input.sessionId)
    const agentId = agentIdOfSession(input.sessionId)
    const model = resolveAgentModel(agentId)
    const settings = agentSettingsOf(agentId)
    const source: 'user' | 'subagent' = (() => {
      const info = sessionInfo(config.profile.dataRoot, input.sessionId)
      return info?.kind === 'agent' || info?.createdBy?.startsWith('agent') ? 'subagent' : 'user'
    })()
    const meta = sessionMeta.metaOf(input.sessionId)
    const assistantPrefill = meta?.thinkingHeadEnabled
      && meta.thinkingHead
      && supportsAssistantPrefill(model)
      ? meta.thinkingHead
      : undefined
    const result = await runTurn(input.text, {
      store,
      writer,
      sessionId: input.sessionId,
      profile: config.profile,
      model,
      tools,
      approvals,
      sections,
      cwd,
      now,
      offload,
      modelRetry,
      ...(modelGate ? { modelGate } : {}),
      priority: input.priority ?? 'interactive',
      agentId,
      source,
      usageLedger,
      ...(assistantPrefill ? { assistantPrefill } : {}),
      ...(skipStartEvent ? { skipStartEvent: true } : {}),
      ...(settings?.tools?.allow !== undefined
        ? { toolAllow: settings.tools.allow }
        : {}),
      ...(settings?.tools?.approval !== undefined
        ? { toolApproval: settings.tools.approval }
        : {}),
      ...(fsPolicy ? { sandbox: fsPolicy } : {}),
      ...(networkPolicy ? { network: networkPolicy } : {}),
      riskGuard,
      ...(leases ? { leases } : {}),
      workspaceId,
      ...(metrics ? { metrics } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onModelEvent ? { onModelEvent: input.onModelEvent } : {}),
      compaction: {
        config: compaction,
        estimator,
        contextWindow: model.model.contextWindow ?? 128_000,
        ...(model.model.maxOutputTokens !== undefined
          ? { maxOutputTokens: model.model.maxOutputTokens }
          : {}),
        spill,
      },
    })
    joinScheduler?.onTurnCompleted(input.sessionId, result.status)
    return result
  }

  /**
   * 排队补一轮，只处理还没被任何完成轮看到的 wake 消息。
   *
   * 用 SessionHost 排队而不是直接跑：目标正在跑时，当前轮可能已经看到这条
   * 消息，等它结束后再检查一次，避免重复开轮。消息本身在事件流里，这一轮
   * 用 skipStartEvent，不需要把文本再写一遍。
   */
  function queueInboxWake(sessionId: string): void {
    if (!sessionLifecycle.canRun(sessionId)) return
    void sessionHost.run(sessionId, async () => {
      if (!sessionLifecycle.canRun(sessionId)) return
      if (pendingWakeMessages(storeFor(sessionId).read()).length === 0) return
      await runSessionTurn({ sessionId, text: '', priority: 'normal' }, true)
    }).catch(() => {
      // runTurn 自己会落 turn.completed；这里只兜底存储层异常，避免未处理拒绝。
    })
  }

  const sendSessionMessage = (input: SendSessionMessageInput): SessionMessageDelivery => {
    if (!sessionLifecycle.canMessage(input.from)) {
      throw new Error(`source session is not active: ${input.from}`)
    }
    if (!sessionLifecycle.canMessage(input.to)) {
      throw new Error(`target session is not active: ${input.to}`)
    }
    const kind = input.kind ?? 'note'
    const wake = input.wake ?? kind !== 'note'
    const link = input.linkId
      ? sessionGraph.get(input.linkId)
      : sessionGraph.links(input.from, { includeClosed: false }).find(item =>
        (item.from === input.from && item.to === input.to)
        || (item.to === input.from && item.from === input.to))
    if (!link || link.status !== 'active') {
      throw new Error(`no active link: ${input.from} -> ${input.to}`)
    }
    if (!sessionGraph.canMessage(input.from, input.to)) {
      throw new Error(`link does not allow messages: ${input.from} -> ${input.to}`)
    }

    const text = input.text.trim()
    if (text.length === 0) throw new Error('session message text is empty')
    ensureSession(input.to)
    const messageId = `msg-${randomUUID()}`
    const event = writerFor(input.to).append({
      stream: sessionStream(input.to),
      actor: 'system',
      type: 'session.message',
      refs: {
        fromSession: input.from,
        link: link.linkId,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      },
      payload: {
        messageId,
        fromSession: input.from,
        linkId: link.linkId,
        kind,
        text,
        hop: Math.max(1, Math.floor(input.hop ?? 1)),
        ...(wake ? { wake: true } : {}),
      },
    })
    writerFor(input.to).flush()

    if (wake) {
      // 目标正在跑时也排队：当前 turn 若已看到这条消息，队列任务会直接跳过；
      // 只有它没看到（消息落在模型请求投影之后），才补一轮。
      queueInboxWake(input.to)
    }

    return { messageId, eventId: event.id, linkId: link.linkId, woke: wake }
  }

  const spawnSession = (input: {
    creator: string
    text: string
    reason?: string
  }): SpawnedSession => {
    const text = input.text.trim()
    if (text.length === 0) throw new Error('spawn text is empty')
    if (!sessionLifecycle.canRun(input.creator)) {
      throw new Error(`creator session is not active: ${input.creator}`)
    }
    const limits = config.patch?.runtime?.sessions
    const maxTotal = limits?.maxTotal ?? 64
    const maxPerCreator = limits?.maxPerCreator ?? 16
    const sessions = listSessions(config.profile.dataRoot, {
      lifecycle: id => sessionLifecycle.stateOf(id),
      includeArchived: true,
    })
    if (sessions.length >= maxTotal) {
      throw new Error(`session quota exceeded: ${sessions.length}/${maxTotal}`)
    }
    const created = sessions.filter(session =>
      session.createdBy === 'agent' && session.createdFrom?.sessionId === input.creator).length
    if (created >= maxPerCreator) {
      throw new Error(`agent session quota exceeded: ${created}/${maxPerCreator}`)
    }

    const sessionId = newSessionId(now(), config.profile.timeZone)
    const creatorAgentId = sessionInfo(
      config.profile.dataRoot,
      input.creator,
      sessionLifecycle.stateOf(input.creator),
    )?.agentId
    pendingProvenance.set(sessionId, {
      createdBy: 'agent',
      createdFrom: { sessionId: input.creator },
      ...(creatorAgentId ? { agentId: creatorAgentId } : {}),
      reason: input.reason ?? 'agent spawned session',
    })
    ensureSession(sessionId)
    const link = sessionGraph.create({
      from: input.creator,
      to: sessionId,
      relation: 'peer',
      createdBy: 'agent',
      reason: 'spawned session',
    })
    const delivery = sendSessionMessage({
      from: input.creator,
      to: sessionId,
      text,
      kind: 'question',
      wake: true,
    })
    return { sessionId, linkId: link.linkId, messageId: delivery.messageId }
  }

  joinScheduler = new SessionJoinScheduler({
    storeFor,
    writerFor,
    isRunning: id => {
      if (!sessionLifecycle.canRun(id)) return false
      const state = inspectEvents(
        id,
        storeFor(id).read(),
        sessionInfo(config.profile.dataRoot, id, sessionLifecycle.stateOf(id)),
      ).state
      return state === 'running' || state === 'waiting'
    },
    linked: (from, to) => sessionGraph.canRead(from, to) || sessionGraph.canMessage(from, to),
    canRun: id => sessionLifecycle.canRun(id),
    wake: id => {
      if (!sessionLifecycle.canRun(id)) return
      void sessionHost.run(id, () => runSessionTurn({ sessionId: id, text: '', priority: 'normal' }, true))
        .catch(() => {
          // runTurn 自己会落 turn.completed；这里只兜底存储层异常。
        })
    },
    now,
  })
  container.register('sessionJoins', joinScheduler)
  container.onDispose('sessionJoins', () => joinScheduler?.dispose())
  tools.register(createSessionJoinTool({ joins: joinScheduler }), 'builtin')
  tools.register(createSessionCreateTool({ spawn: spawnSession }), 'builtin')
  tools.register(createSessionMessageTool({ send: sendSessionMessage }), 'builtin')

  for (const name of disabledTools) {
    if (tools.get(name)) tools.setEnabled(name, false)
  }
  for (const [name, mode] of Object.entries(config.patch?.tools?.approval ?? {})) {
    if (tools.get(name)) tools.update(name, { approval: mode })
  }

  const requireSession = (sessionId: string): SessionInfo => {
    const info = sessionInfo(
      config.profile.dataRoot,
      sessionId,
      sessionLifecycle.stateOf(sessionId),
    )
    if (!info) throw new Error(`session not found: ${sessionId}`)
    return info
  }

  const archiveSession = (
    sessionId: string,
    input: SessionLifecycleInput = {},
  ): SessionLifecycleRecord => {
    const current = sessionLifecycle.stateOf(sessionId)
    if (current === 'deleted') throw new Error(`session is deleted: ${sessionId}`)
    requireSession(sessionId)
    if (current === 'archived') return sessionLifecycle.recordOf(sessionId)!
    if (sessionHost.isActive(sessionId) && input.force !== true) {
      throw new SessionBusyError(sessionId)
    }
    const record = sessionLifecycle.archive(sessionId, input.by ?? 'user', input.reason)
    // 归档后不再有新的完成轮，涉及它的等待不该继续空等。
    joinScheduler?.cancelInvolving(sessionId, `会话已归档：${sessionId}`)
    return record
  }

  const unarchiveSession = (
    sessionId: string,
    input: SessionLifecycleInput = {},
  ): SessionLifecycleRecord => {
    requireSession(sessionId)
    return sessionLifecycle.unarchive(sessionId, input.by ?? 'user', input.reason)
  }

  const deleteSession = (
    sessionId: string,
    input: SessionLifecycleInput = {},
  ): SessionLifecycleRecord => {
    const current = sessionLifecycle.stateOf(sessionId)
    if (current === 'deleted') return sessionLifecycle.recordOf(sessionId)!
    requireSession(sessionId)
    if (sessionHost.isActive(sessionId) && input.force !== true) {
      throw new SessionBusyError(sessionId)
    }
    const by = input.by ?? 'user'
    // 先落终态，后续清理即使失败也不会让会话重新可写。
    const record = sessionLifecycle.delete(sessionId, by, input.reason)
    for (const link of sessionGraph.links(sessionId, { includeClosed: false })) {
      sessionGraph.close(link.linkId, by, `session deleted: ${sessionId}`)
    }
    joinScheduler?.cancelInvolving(sessionId, `会话已删除：${sessionId}`)
    return record
  }

  const app: App = {
    config,
    models,
    tools,
    presets,
    approvals,
    agents,
    compaction,

    async chat(input) {
      return sessionHost.run(input.sessionId, () => runSessionTurn(input))
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
      const offset = Math.max(0, Math.floor(input.offset ?? 0))
      const limit = Math.max(1, Math.floor(input.limit ?? 20_000))

      const fromRef = (ref: string, mime?: string, encoding?: string) => {
        if (ref.startsWith('blob:')) {
          const slice = blobs.readText(ref, { offset, limit, encoding: encoding ?? 'utf-8' })
          return {
            data: slice.text,
            offset: slice.offset,
            totalChars: slice.totalChars,
            eof: slice.eof,
            bytes: slice.bytes,
            ...(mime ? { mime } : {}),
            ...(encoding ? { encoding } : {}),
          }
        }
        const text = spill.store.get(ref)
        return slicePayload(text, offset, limit, {
          ...(mime ? { mime } : {}),
          // spill 文件同样是 UTF-8 文本
          encoding: 'utf-8',
        })
      }

      if (input.ref) {
        return fromRef(input.ref, 'text/plain', 'utf-8')
      }

      if (input.eventId) {
        const event = store.read().find(item => item.id === input.eventId)
        if (!event) throw new Error(`event not found: ${input.eventId}`)
        const payload = event.payload as {
          text?: unknown
          ref?: unknown
          mime?: unknown
          encoding?: unknown
          contentRef?: { ref?: unknown; encoding?: unknown } | undefined
          structuredRef?: { ref?: unknown; encoding?: unknown } | undefined
        }
        const field = input.field ?? 'text'
        const ref = field === 'structured'
          ? (typeof payload.structuredRef?.ref === 'string' ? payload.structuredRef.ref : undefined)
          : (typeof payload.contentRef?.ref === 'string'
              ? payload.contentRef.ref
              : typeof payload.ref === 'string' ? payload.ref : undefined)
        if (ref) {
          const contentRef = payload.contentRef
          return fromRef(
            ref,
            field === 'structured' ? 'application/json' : (typeof payload.mime === 'string' ? payload.mime : 'text/plain'),
            field === 'structured'
              ? 'utf-8'
              : (typeof contentRef?.encoding === 'string'
                  ? contentRef.encoding
                  : 'utf-8'),
          )
        }
        return slicePayload(
          String(payload.text ?? ''),
          offset,
          limit,
          {
            ...(typeof payload.mime === 'string' ? { mime: payload.mime } : {}),
            ...(typeof payload.encoding === 'string' ? { encoding: payload.encoding } : {}),
          },
        )
      }

      throw new Error('payload needs ref or eventId')
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
          ...(entry.reason ? { reason: entry.reason } : {}),
        }))
    },

    async compact(sessionId) {
      const store = storeFor(sessionId)
      const writer = writerFor(sessionId)
      const agentId = agentIdOfSession(sessionId)
      const model = resolveAgentModel(agentId)
      const settings = agentSettingsOf(agentId)
      const allowed = settings?.tools?.allow !== undefined
        ? new Set(settings.tools.allow)
        : new Set(tools.list().filter(tool => tool.source !== 'plugin').map(tool => tool.name))
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

      const result = await compactIfNeeded({
        store,
        writer,
        stream: sessionStream(sessionId),
        config: compaction,
        estimator,
        contextWindow: model.model.contextWindow ?? 128_000,
        ...(model.model.maxOutputTokens !== undefined
          ? { maxOutputTokens: model.model.maxOutputTokens }
          : {}),
        system: rendered.system,
        tools: tools.toModelSpecs({ allowed }),
        messages: rendered.messages,
        currentTurn,
        projectMessages: () => projectHistory(store.read()),
        spill,
      })
      try {
        archiveCompactedSegments(store)
      } catch {
        // 归档失败不阻塞手动压缩
      }
      return result
    },

    createSession(input) {
      const requested = input?.id?.trim()
      let sessionId: string
      if (requested) {
        // sessionFile 会先做安全段校验；再查重，避免复用已归档/已软删的 ID。
        const file = sessionFile(config.profile.dataRoot, requested)
        if (requested.startsWith('agent-')) {
          throw new Error('session id prefix agent- is reserved for agent runs')
        }
        if (existsSync(file) || pendingProvenance.has(requested)) {
          throw new Error(`session id already exists: ${requested}`)
        }
        sessionId = requested
      } else {
        sessionId = newSessionId(now(), config.profile.timeZone)
      }
      if (input) {
        const { id: _id, materialize: _materialize, ...provenance } = input
        pendingProvenance.set(sessionId, provenance)
        if (input.materialize === true) ensureSession(sessionId)
      }
      return sessionId
    },

    sessions(options = {}) {
      return listSessions(config.profile.dataRoot, {
        lifecycle: id => sessionLifecycle.stateOf(id),
        includeArchived: options.includeArchived ?? false,
        includeDeleted: options.includeDeleted ?? false,
        withState: true,
        withTitle: true,
        meta: id => sessionMeta.metaOf(id),
      })
    },

    setSessionMeta(sessionId, input) {
      requireSession(sessionId)
      if (input.thinkingHeadEnabled === true) {
        const text = input.thinkingHead?.trim() || sessionMeta.metaOf(sessionId)?.thinkingHead
        if (!text) throw new Error('thinking head text is required')
        const agentId = agentIdOfSession(sessionId)
        let supported = false
        try {
          supported = supportsAssistantPrefill(resolveAgentModel(agentId))
        } catch {
          supported = false
        }
        if (!supported) {
          throw new Error('current model endpoint does not support assistant prefill')
        }
      }
      return sessionMeta.set(sessionId, input)
    },

    recoverInboxes() {
      let pending = 0
      for (const session of listSessions(config.profile.dataRoot, {
        lifecycle: id => sessionLifecycle.stateOf(id),
      })) {
        const store = ensureSession(session.id)
        if (pendingWakeMessages(store.read()).length === 0) continue
        pending += 1
        queueInboxWake(session.id)
      }
      return pending
    },

    sessionState(sessionId) {
      return sessionLifecycle.stateOf(sessionId)
    },
    archiveSession,
    unarchiveSession,
    deleteSession,

    sessionEvents(sessionId, options) {
      return tailSession(sessionId, storeFor(sessionId).read(), options)
    },

    inspectSession(sessionId) {
      // 归档/删除的会话不再恢复等待，inspect 本身保持只读。
      if (sessionLifecycle.canRun(sessionId)) joinScheduler?.restore(sessionId)
      const info = sessionInfo(
        config.profile.dataRoot,
        sessionId,
        sessionLifecycle.stateOf(sessionId),
      )
      const store = storeFor(sessionId)
      let tail: ReturnType<typeof readSessionTail> = { events: [], total: 0, truncated: false }
      try {
        tail = readSessionTail(store.file)
        if (tail.events.length === 0) {
          // 刚轮转过、当前段还没写入：退回上一段尾部
          const segments = store.segments()
          const previous = segments.length > 1 ? segments[segments.length - 2] : undefined
          if (previous) tail = readSessionTail(previous)
        }
      } catch {
        // 文件在读取期间被归档/删除：按空尾处理
      }
      return {
        ...inspectEvents(sessionId, tail.events, info, {
          totalEvents: tail.total,
          truncated: tail.truncated,
        }),
        links: sessionGraph.links(sessionId, { includeClosed: false }),
        joins: joinScheduler!.pending(sessionId).map(record => ({
          ...record,
          satisfied: [...record.satisfied],
        })),
      }
    },

    links(sessionId, options) {
      return sessionGraph.links(sessionId, options)
    },

    link(input) {
      return sessionGraph.create({ ...input, createdBy: input.createdBy ?? 'user' })
    },

    unlink(linkId, reason) {
      return sessionGraph.close(linkId, 'user', reason)
    },

    sendMessage: sendSessionMessage,
    spawnSession,

    async wake(sessionId, text) {
      if (!sessionLifecycle.canRun(sessionId)) {
        throw new Error(`session is not active: ${sessionId} (${sessionLifecycle.stateOf(sessionId)})`)
      }
      ensureSession(sessionId)
      if (text && text.trim().length > 0) {
        writerFor(sessionId).append({
          stream: sessionStream(sessionId),
          actor: 'system',
          type: 'message.system',
          payload: { text, mark: 'injection' },
        })
        writerFor(sessionId).flush()
      }
      return sessionHost.run(sessionId, () => runSessionTurn({
        sessionId,
        text: text ?? '',
      }, true))
    },

    join(input) {
      if (!sessionLifecycle.canRun(input.sessionId)) {
        throw new Error(`join session is not active: ${input.sessionId}`)
      }
      ensureSession(input.sessionId)
      return joinScheduler!.create(input)
    },

    cancelJoins(sessionId, joinId) {
      return joinScheduler!.cancel(sessionId, joinId)
    },

    pendingJoins(sessionId) {
      if (sessionId) joinScheduler!.restore(sessionId)
      return joinScheduler!.pending(sessionId)
    },

    requestAgent(input) {
      const preset: AgentPreset | undefined = presets.get(input.preset)
      if (!preset) throw new Error(`unknown preset: ${input.preset}`)
      const policy = subagentPolicyOf(input.sourceSession)
      if (policy?.presets && !policy.presets.includes(preset.id)) {
        throw new Error(`preset not allowed for this agent: ${preset.id}`)
      }
      const allowedModels = new Set((policy?.models ?? []).map(choice =>
        `${choice.provider}\u0000${choice.model}`))
      let models = allowedModels.size > 0
        ? preset.models.filter(choice =>
          allowedModels.has(`${choice.provider}\u0000${choice.model}`))
        : [...preset.models]
      if (models.length === 0 && policy?.mainModel) models = [policy.mainModel]
      if (models.length === 0) throw new Error(`no model available for preset: ${preset.id}`)
      const toolAllow = policy?.toolAllow !== undefined
        ? new Set(policy.toolAllow)
        : undefined
      const effective: AgentPreset = {
        ...preset,
        models,
        tools: preset.tools.filter(name => !toolAllow || toolAllow.has(name)),
      }
      return agents.submit({
        preset: effective.id,
        prompt: input.prompt,
        ...(input.context ? { context: input.context } : {}),
        ...(input.acceptance ? { acceptance: input.acceptance } : {}),
        priority: input.priority ?? 'normal',
        source: {
          session: input.sourceSession,
          ...(input.sourceTurn !== undefined ? { turn: input.sourceTurn } : {}),
        },
      }, effective)
    },

    agentStatus(id) {
      return agents.status(id)
    },

    agentList(limit) {
      return agents.list(limit)
    },

    agentRuns(options = {}) {
      return listAgentRuns(config.profile.dataRoot, {
        lifecycle: id => sessionLifecycle.stateOf(id),
        includeArchived: options.includeArchived ?? false,
        includeDeleted: options.includeDeleted ?? false,
      })
    },

    agentInterrupt(id) {
      return agents.interrupt(id)
    },

    mainAgents() {
      return manifestStore?.list() ?? []
    },

    agentSummaries() {
      const ids = new Set<string>([mainAgentId])
      for (const manifest of manifestStore?.list() ?? []) ids.add(manifest.id)
      for (const settings of agentSettings.list()) ids.add(settings.agentId)
      const counts = sessionCounts()
      return [...ids].sort().map(id => agentSummaryOf(id, counts))
    },

    agentSummary(agentId) {
      return agentSummaryOf(agentId)
    },

    async updateAgentSettings(agentId, input) {
      if (input.model) {
        try {
          resolveModelWithOverrides(input.model.provider, input.model.model)
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error))
        }
      }
      for (const choice of input.subagentModels ?? []) {
        try {
          resolveModelWithOverrides(choice.provider, choice.model)
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error))
        }
      }
      for (const preset of input.subagentPresets ?? []) {
        if (!presets.get(preset)) throw new Error(`unknown preset: ${preset}`)
      }
      for (const name of input.tools?.allow ?? []) {
        if (!tools.get(name)) throw new Error(`unknown tool: ${name}`)
      }
      for (const name of Object.keys(input.tools?.approval ?? {})) {
        if (!tools.get(name)) throw new Error(`unknown tool: ${name}`)
      }

      await agentSettings.update(agentId, current => {
        const main = input.model ?? current.models?.main
        const subagents = input.subagentModels ?? current.models?.subagents ?? []
        const toolsSettings = input.tools === undefined
          ? current.tools
          : {
            ...(input.tools.allow !== undefined
              ? { allow: input.tools.allow }
              : current.tools?.allow !== undefined ? { allow: current.tools.allow } : {}),
            ...(input.tools.approval !== undefined
              ? { approval: input.tools.approval }
              : current.tools?.approval ? { approval: current.tools.approval } : {}),
          }
        return {
          ...current,
          models: {
            ...(main ? { main } : {}),
            subagents,
          },
          ...(input.subagentPresets !== undefined
            ? { subagentPresets: input.subagentPresets }
            : current.subagentPresets !== undefined
              ? { subagentPresets: current.subagentPresets }
              : {}),
          ...(toolsSettings ? { tools: toolsSettings } : {}),
        }
      })
      return agentSummaryOf(agentId)
    },

    toolViews(agentId) {
      return toolViewsOf(agentId)
    },

    async setToolGlobal(name, input) {
      if (!tools.get(name)) throw new Error(`unknown tool: ${name}`)
      const dangerous = Boolean(tools.get(name)?.meta?.dangerous)
      const plugin = tools.policy(name)?.source === 'plugin'
      await writeConfigFile(raw => {
        if (!raw.patch) raw.patch = {}
        if (!raw.patch.tools) raw.patch.tools = {}
        const target = raw.patch.tools
        if (!Array.isArray(target.enabled)) target.enabled = []
        if (!Array.isArray(target.disabled)) target.disabled = []
        if (!target.approval) target.approval = {}
        if (input.enabled !== undefined) {
          target.enabled = target.enabled.filter(item => item !== name)
          target.disabled = target.disabled.filter(item => item !== name)
          if (input.enabled) {
            // 安全工具过去默认开、不需要写名单；插件工具默认关，
            // 必须把启用状态写回去，否则重启后又变回停用。
            if (dangerous || plugin) target.enabled.push(name)
          } else {
            target.disabled.push(name)
          }
        }
        if (input.approval !== undefined) {
          target.approval[name] = input.approval
        }
      })
      tools.update(name, {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.approval !== undefined ? { approval: input.approval } : {}),
      })
      return toolViewsOf()
    },

    updateStatus() {
      return updateService.status()
    },

    checkUpdate() {
      return updateService.check()
    },

    startUpdateDownload() {
      return updateService.startDownload()
    },

    updateJob() {
      return updateService.job()
    },

    stageUpdatePackage(zipPath) {
      return updateService.stagePackage(zipPath)
    },

    applyUpdate() {
      return updateService.requestApply()
    },

    rollbackUpdate() {
      return updateService.requestRollback()
    },

    async saveUpdateConfig(input) {
      const manifestUrl = input.manifestUrl?.trim() ?? ''
      await writeConfigFile(raw => {
        const update = typeof raw.update === 'object' && raw.update !== null && !Array.isArray(raw.update)
          ? raw.update as Record<string, unknown>
          : {}
        if (manifestUrl === '') delete update.manifestUrl
        else update.manifestUrl = manifestUrl
        raw.update = update
      })
      updateService.setManifestUrl(manifestUrl)
      return updateService.status()
    },

    pluginList() {
      return { plugins: pluginRegistry.list(), errors: pluginRegistry.errors() }
    },

    async pluginEnable(id) {
      return pluginRegistry.enable(id)
    },

    async pluginDisable(id) {
      return pluginRegistry.disable(id)
    },

    pluginPanel(pluginId, panelId) {
      return pluginRegistry.panel(pluginId, panelId)
    },

    async createMainAgent(input) {
      if (!manifestStore) throw new Error('memory is not configured')
      return manifestStore.createDefault(input.id, input.name)
    },

    async deleteMainAgent(agentId) {
      if (!manifestStore) throw new Error('memory is not configured')
      if (agentId === mainAgentId) {
        throw new Error('默认主 agent 不能删除；要换身份请新建 agent 并改默认配置。')
      }
      const hasMemoryAgent = existsSync(manifestStore.dir(agentId))
      const hasSettings = existsSync(agentSettings.dir(agentId))
      if (!hasMemoryAgent && !hasSettings) throw new Error(`agent not found: ${agentId}`)

      const sessionCount = sessionsOfAgent(agentId).length
      if (sessionCount > 0) {
        throw new Error(
          `agent ${agentId} 还有 ${sessionCount} 个未删除的会话（含归档），先删除或彻底删除这些会话。`,
        )
      }

      // 记忆库和数据目录各有一份；两边同名挪到 .trash，失败时把已挪的挪回去。
      const stamp = now().toISOString().replace(/[:.]/g, '-')
      const moves: Array<{ from: string; to: string }> = []
      try {
        if (hasMemoryAgent) moves.push(manifestStore.removeToTrash(agentId, stamp))
        const settingsMove = hasSettings ? agentSettings.removeToTrash(agentId, stamp) : undefined
        if (settingsMove) moves.push(settingsMove)
      } catch (error) {
        for (const move of [...moves].reverse()) {
          try {
            renameSync(move.to, move.from)
          } catch {
            // 回滚失败不掩盖原始错误；目录仍在 .trash，可人工找回。
          }
        }
        throw error
      }
      return { id: agentId, trash: moves.map(move => move.to) }
    },

    mainAgentIdentity(agentId) {
      if (!manifestStore || !memoryRoot) {
        throw new Error('memory is not configured')
      }
      const manifest = manifestStore.readOrThrow(agentId)
      const store = new AgentIdentityStore(memoryRoot, agentId, { manifest })
      return {
        manifest,
        slots: store.slots().map(slot => ({
          ...slot,
          path: store.path(slot.id),
          content: store.readOrEmpty(slot.id),
        })),
      }
    },

    async writeMainAgentSlot(agentId, slotId, content) {
      if (!manifestStore || !memoryRoot) {
        throw new Error('memory is not configured')
      }
      const manifest = manifestStore.readOrThrow(agentId)
      const store = new AgentIdentityStore(memoryRoot, agentId, { manifest })
      const previous = store.readOrEmpty(slotId)
      const result = await store.writeSlot(slotId, content)
      if (previous !== content) {
        notifyPersonaChanged(agentId, store.slot(slotId).label)
      }
      return result
    },

    mainAgentIdentityBackups(agentId) {
      if (!manifestStore || !memoryRoot) {
        throw new Error('memory is not configured')
      }
      const manifest = manifestStore.readOrThrow(agentId)
      const store = new AgentIdentityStore(memoryRoot, agentId, { manifest })
      return store.listBackups()
    },

    async restoreMainAgentIdentity(agentId, file) {
      if (!manifestStore || !memoryRoot) {
        throw new Error('memory is not configured')
      }
      const manifest = manifestStore.readOrThrow(agentId)
      const store = new AgentIdentityStore(memoryRoot, agentId, { manifest })
      const result = await store.restoreBackup(file)
      notifyPersonaChanged(agentId, store.slot(result.slot).label)
      return result
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

    metrics() {
      return metrics?.snapshot() ?? {
        startedAt: now().toISOString(),
        counters: [],
        histograms: [],
        gauges: [],
      }
    },

    usageStats() {
      return usageLedger.stats()
    },

    usageOverview(filter, options) {
      return usageLedger.overview(filter, options ?? {})
    },

    usageTimeline(filter, options) {
      return usageLedger.timeline(filter, options ?? {})
    },

    usageGroups(filter, options) {
      return usageLedger.groups(filter, options)
    },

    usageRequests(filter, options) {
      return usageLedger.requests(filter, options ?? {})
    },

    embeddingModels() {
      return embeddingStore.list()
    },

    startEmbeddingInstall(id, options) {
      return embeddingJobs.start(id, options)
    },

    embeddingInstallJob(id) {
      return embeddingJobs.get(id)
    },

    activateEmbeddingModel(id) {
      const status = embeddingStore.activate(id)
      void semanticMemoryIndex?.build().catch(() => undefined)
      return status
    },

    removeEmbeddingModel(id) {
      embeddingStore.remove(id)
      semanticMemoryIndex?.markDirty()
      return embeddingStore.list()
    },

    modelConfig() {
      return modelConfigView()
    },

    saveModelConfig,
    addModelProvider,
    modelProviderTemplates() {
      return BUILTIN_PROVIDERS
    },
    addModelApiKey,
    removeModelApiKey,
    updateModelApiKey,
    revealModelApiKey,
    modelBalance,
    addProviderModels,
    removeModelProvider,
    probeModelProvider,
    saveModelCard,

    memoryRoot() {
      return memoryRoot
    },

    memoryPolicy(sessionId, agentId) {
      if (!memoryPolicyStore) throw new Error('memory is not configured')
      return memoryPolicyStore.resolve(sessionId ?? '', agentId)
    },

    setMemoryPolicy(input) {
      if (!memoryPolicyStore) throw new Error('memory is not configured')
      memoryPush?.invalidate()
      if (input.scope === 'default') {
        memoryPolicyStore.setDefault(input.policy)
        return memoryPolicyStore.resolve('')
      }
      const id = input.id?.trim()
      if (!id) throw new Error(`${input.scope} policy needs id`)
      if (input.scope === 'agent') {
        memoryPolicyStore.setAgent(id, input.policy)
        return memoryPolicyStore.resolve('', id)
      }
      memoryPolicyStore.setSession(id, input.policy)
      return memoryPolicyStore.resolve(id)
    },

    memoryRole(sessionId) {
      return memoryAccess?.roleFor(sessionId)
    },

    grantMemory(sessionId, role) {
      if (!memoryAccess) throw new Error('memory is not configured')
      return memoryAccess.grant(sessionId, role)
    },

    memorySearch(query, limit = 20) {
      if (memorySearchIndex) return memorySearchIndex.search(query, { limit })
      return memoryStore?.search(query, limit) ?? []
    },

    memoryIndex() {
      return memoryStore?.listDocuments({ includePrivate: true, includeInvalid: true }) ?? []
    },

    memoryLibraryTree() {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.tree()
    },

    memoryLibraryRead(path) {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.read(path)
    },

    async memoryLibraryWrite(path, text) {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.write(path, text)
    },

    async memoryLibraryMkdir(path) {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.mkdir(path)
    },

    async memoryLibraryMove(from, to) {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.move(from, to)
    },

    async memoryLibraryRemove(path, permanent = false) {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.remove(path, { permanent })
    },

    memoryLibraryTrash() {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.trash()
    },

    async memoryLibraryRestore(id, to) {
      if (!memoryLibrary) throw new Error('memory is not configured')
      return memoryLibrary.restore(id, to)
    },

    memoryCommitStatus() {
      if (!memoryCommitter) throw new Error('memory is not configured')
      return memoryCommitter.status()
    },

    async commitMemory() {
      if (!memoryCommitter) throw new Error('memory is not configured')
      await memoryCommitter.commitNow()
    },

    rebuildMemorySummaries() {
      if (!memorySummaryWorker) throw new Error('memory is not configured')
      if (!memorySummaryWorker.canGenerate) {
        throw new Error('memory summary generator is not configured')
      }
      const queued = memorySummaryWorker.enqueueAll()
      return { queued, status: memorySummaryWorker.status() }
    },

    memorySummaryStatus() {
      if (!memorySummaryWorker) throw new Error('memory is not configured')
      return memorySummaryWorker.status()
    },

    memoryIndexList() {
      if (!memoryStore) throw new Error('memory is not configured')
      return generateIndex({ memoryRoot: memoryStore.root })
    },

    reindexMemory() {
      if (!memoryStore) throw new Error('memory is not configured')
      return writeIndex({ memoryRoot: memoryStore.root })
    },

    memoryLogTree() {
      if (!memoryStore) throw new Error('memory is not configured')
      return listLogTree(memoryStore.root)
    },

    memoryLogPage(day, sid, options) {
      if (!memoryStore) throw new Error('memory is not configured')
      return readLogPage(memoryStore.root, day, sid, options)
    },

    memoryLogSearch(query, limit = 200) {
      if (!memoryStore) throw new Error('memory is not configured')
      return searchLogs(memoryStore.root, query, limit)
    },

    memoryRead(target) {
      if (!memoryStore) throw new Error('memory is not configured')
      return memoryStore.read(target)
    },

    async saveMemoryDocument(target, doc) {
      if (!memoryStore) throw new Error('memory is not configured')
      return memoryStore.saveDocument(target, doc)
    },

    memoryProposals(status) {
      return memoryProposals?.list(status) ?? []
    },

    async acceptMemoryProposal(proposalId) {
      if (!memoryStore || !memoryProposals) throw new Error('memory is not configured')
      return memoryProposals.accept(proposalId, memoryStore, memoryIdentity)
    },

    rejectMemoryProposal(proposalId) {
      if (!memoryProposals) throw new Error('memory is not configured')
      return memoryProposals.reject(proposalId)
    },

    async dispose() {
      if (disposed) return
      disposed = true
      await container.dispose()
    },
  }

  return app
}
