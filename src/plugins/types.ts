import type { ToolDefinition } from '../tools/types.ts'

/** 宿主接受的插件 API 大版本。不兼容的插件拒绝加载，不静默降级。 */
export const PLUGIN_API_VERSION = 1

export type PluginKind = 'tool' | 'ui-panel'

export type PluginCapability = 'tools.register' | 'ui.panel' | 'storage'

export type PluginTrust = 'builtin' | 'dev'

export type PluginStatus = 'inactive' | 'activating' | 'active' | 'disabled' | 'error'

export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly apiVersion: number
  /** dev 插件必填；builtin 可以内联，不读文件。 */
  readonly entry?: string
  readonly description?: string
  readonly provides: readonly PluginKind[]
  readonly capabilities: readonly PluginCapability[]
}

/** 插件注册的面板。html 由宿主放进 sandbox iframe 的 srcdoc。 */
export interface PluginPanel {
  readonly id: string
  readonly title: string
  readonly html: string
  readonly slot?: 'settings'
  readonly width?: number
  readonly height?: number
}

/** 列表里只给元数据，不回传 html。 */
export interface PluginPanelInfo {
  readonly id: string
  readonly title: string
  readonly slot?: 'settings'
  readonly width?: number
  readonly height?: number
}

export interface PluginInfo {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly apiVersion: number
  readonly description?: string
  readonly trust: PluginTrust
  readonly status: PluginStatus
  readonly provides: readonly PluginKind[]
  readonly capabilities: readonly PluginCapability[]
  readonly tools: readonly string[]
  readonly panels: readonly PluginPanelInfo[]
  readonly error?: string
}

export interface PluginLoadError {
  readonly path: string
  readonly error: string
}

export interface PluginListResult {
  readonly plugins: readonly PluginInfo[]
  readonly errors: readonly PluginLoadError[]
}

export interface PluginPanelContent extends PluginPanelInfo {
  readonly pluginId: string
  readonly html: string
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  keys(): Promise<string[]>
}

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type PluginDisposable = (() => void | Promise<void>) | { dispose(): void | Promise<void> }

export interface PluginContext {
  readonly plugin: {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly dataDir: string
  }
  /** 插件卸载时 abort；异步工作应观察它。 */
  readonly signal: AbortSignal
  readonly tools: {
    /** 注册后工具名会变成 `<plugin>__<tool>`；默认全局停用、审批 required。 */
    register(tool: ToolDefinition): PluginDisposable
  }
  readonly ui: {
    /** 面板只会在 sandbox iframe 里渲染。 */
    registerPanel(panel: PluginPanel): PluginDisposable
  }
  readonly storage: PluginStorage
  /** 只读插件包内资源；不能越出插件目录。 */
  readonly assets: {
    read(path: string): Promise<string>
  }
  readonly log: PluginLogger
  /**
   * 立即执行 effect；它返回的 disposer 会在插件卸载时调用。
   * 不是“注册一个稍后执行的清理函数”，要清理请返回函数/对象。
   */
  effect(effect: () => PluginDisposable | void): PluginDisposable
}

export interface PluginDefinition {
  readonly manifest: PluginManifest
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** dev 插件入口模块的形状。 */
export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
