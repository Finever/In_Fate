import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ToolContext, ToolDefinition } from '../tools/types.ts'
import {
  parsePluginManifest,
  pluginToolName,
  readPluginAsset,
  resolvePluginPath,
} from './manifest.ts'
import { FilePluginStorage } from './storage.ts'
import {
  PLUGIN_API_VERSION,
  type PluginCapability,
  type PluginContext,
  type PluginDefinition,
  type PluginDisposable,
  type PluginInfo,
  type PluginLoadError,
  type PluginManifest,
  type PluginModule,
  type PluginPanel,
  type PluginPanelContent,
  type PluginPanelInfo,
  type PluginStorage,
  type PluginTrust,
} from './types.ts'

const ACTIVATE_TIMEOUT_MS = 5_000
const DEACTIVATE_TIMEOUT_MS = 5_000
const PANEL_HTML_LIMIT = 1024 * 1024
const PANEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const PANEL_CSP = [
  '<meta http-equiv="Content-Security-Policy" content="',
  "default-src 'none'; ",
  "script-src 'unsafe-inline'; ",
  "style-src 'unsafe-inline'; ",
  "img-src data:; ",
  "font-src data:; ",
  "base-uri 'none'; ",
  "form-action 'none'; ",
  '">',
].join('')

/** 面板一律自包含：不允许外部脚本、样式、图片或网络请求。 */
function withPanelCsp(html: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, tag => `${tag}\n${PANEL_CSP}`)
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, tag => `${tag}\n<head>${PANEL_CSP}</head>`)
  }
  return `<!doctype html><html><head>${PANEL_CSP}</head><body>${html}</body></html>`
}

export interface PluginRegistryOptions {
  readonly dataRoot: string
  readonly tools: ToolRegistry
  readonly builtins?: readonly PluginDefinition[]
  /** 默认 false；只有显式开启才扫描 dev 插件目录。 */
  readonly dev?: boolean
  readonly devDir?: string
  /** 配置里全局启用的工具名（包含插件命名空间后的名字）。 */
  readonly enabledTools?: ReadonlySet<string>
  readonly disabledTools?: ReadonlySet<string>
  readonly toolApproval?: Readonly<Record<string, 'auto' | 'required'>>
  readonly now?: () => string
}

interface PluginState {
  version: 1
  enabled: Record<string, boolean>
}

interface PluginRecord {
  readonly manifest: PluginManifest
  readonly trust: PluginTrust
  readonly dir?: string
  module?: PluginModule
  status: 'inactive' | 'activating' | 'active' | 'error'
  error?: string
  runtime?: Runtime
  readonly panels: Map<string, PluginPanel>
  readonly tools: Set<string>
}

const noopDisposable: PluginDisposable = () => undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function disposeOf(value: PluginDisposable): Promise<void> {
  if (typeof value === 'function') await value()
  else await value.dispose()
}

class Runtime {
  readonly disposables: PluginDisposable[] = []
  readonly controller = new AbortController()
  readonly tools = new Set<string>()
  readonly panels = new Set<string>()
  active = true

  add(value: PluginDisposable | void): PluginDisposable {
    if (!value) return noopDisposable
    let disposed = false
    const wrapped: PluginDisposable = {
      dispose: async () => {
        if (disposed) return
        disposed = true
        await disposeOf(value)
      },
    }
    this.disposables.push(wrapped)
    return wrapped
  }

  async disposeAll(): Promise<void> {
    this.active = false
    this.controller.abort(new Error('plugin unloaded'))
    for (const item of [...this.disposables].reverse()) {
      try {
        await disposeOf(item)
      } catch (error) {
        console.error('[plugin] dispose failed:', error)
      }
    }
    this.disposables.length = 0
    this.tools.clear()
    this.panels.clear()
  }
}

export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>()
  private readonly loadErrors: PluginLoadError[] = []
  private readonly statePath: string
  private readonly storageRoot: string
  private readonly devDir: string
  private readonly now: () => string
  private state: PluginState
  private started = false
  private devLoaded = false
  private startTask?: Promise<void>
  private readonly options: PluginRegistryOptions

  constructor(options: PluginRegistryOptions) {
    this.options = options
    this.statePath = join(options.dataRoot, 'plugin-state.json')
    this.storageRoot = join(options.dataRoot, 'plugin-data')
    this.devDir = options.devDir ?? join(options.dataRoot, 'plugins')
    this.now = options.now ?? (() => new Date().toISOString())
    mkdirSync(this.storageRoot, { recursive: true })
    this.state = this.loadState()
    for (const definition of options.builtins ?? []) this.addBuiltin(definition)
  }

  /** 扫描 dev 插件并激活已启用的项。单个失败只记录，不阻塞其它插件。 */
  start(): Promise<void> {
    this.startTask ??= this.doStart()
    return this.startTask
  }

  private async doStart(): Promise<void> {
    if (this.started) return
    this.started = true
    this.loadDevPlugins()
    for (const record of this.records.values()) {
      if (!this.isEnabled(record)) continue
      if (record.status === 'error') continue
      try {
        await this.activate(record)
      } catch {
        // activate 内部已经把错误写进 record。
      }
    }
  }

  async stop(): Promise<void> {
    if (this.startTask) await this.startTask.catch(() => undefined)
    for (const record of [...this.records.values()].reverse()) {
      await this.deactivate(record)
    }
    this.started = false
    this.startTask = undefined
  }

  list(): PluginInfo[] {
    return [...this.records.values()]
      .sort((a, b) =>
        (a.trust === b.trust ? 0 : a.trust === 'builtin' ? -1 : 1)
        || a.manifest.name.localeCompare(b.manifest.name, 'zh'))
      .map(record => this.info(record))
  }

  errors(): PluginLoadError[] {
    return [...this.loadErrors]
  }

  async enable(id: string): Promise<PluginInfo> {
    const record = this.mustGet(id)
    if (record.manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(`plugin ${id} requires apiVersion ${record.manifest.apiVersion}; host supports ${PLUGIN_API_VERSION}`)
    }
    this.state.enabled[id] = true
    this.saveState()
    await this.activate(record)
    if (record.status === 'error') throw new Error(record.error ?? `plugin ${id} failed to activate`)
    return this.info(record)
  }

  async disable(id: string): Promise<PluginInfo> {
    const record = this.mustGet(id)
    this.state.enabled[id] = false
    this.saveState()
    await this.deactivate(record)
    if (record.status !== 'error') record.status = 'inactive'
    return this.info(record)
  }

  panel(pluginId: string, panelId: string): PluginPanelContent | undefined {
    const record = this.records.get(pluginId)
    if (!record || record.status !== 'active') return undefined
    const panel = record.panels.get(panelId)
    if (!panel) return undefined
    return {
      pluginId,
      id: panel.id,
      title: panel.title,
      html: panel.html,
      ...(panel.slot ? { slot: panel.slot } : {}),
      ...(panel.width !== undefined ? { width: panel.width } : {}),
      ...(panel.height !== undefined ? { height: panel.height } : {}),
    }
  }

  private addBuiltin(definition: PluginDefinition): void {
    const manifest = parsePluginManifest(
      definition.manifest,
      `builtin:${definition.manifest.id}`,
      { requireEntry: false },
    )
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(`builtin plugin ${manifest.id} apiVersion is not ${PLUGIN_API_VERSION}`)
    }
    if (this.records.has(manifest.id)) throw new Error(`duplicate plugin id: ${manifest.id}`)
    this.records.set(manifest.id, {
      manifest,
      trust: 'builtin',
      module: definition,
      status: 'inactive',
      panels: new Map(),
      tools: new Set(),
    })
  }

  private loadDevPlugins(): void {
    if (!this.options.dev || this.devLoaded) return
    this.devLoaded = true
    mkdirSync(this.devDir, { recursive: true })
    for (const entry of readdirSync(this.devDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(this.devDir, entry.name)
      const manifestPath = join(dir, 'plugin.json')
      try {
        if (lstatSync(manifestPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
          throw new Error('plugin.json must not be a symlink')
        }
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
        const manifest = parsePluginManifest(raw, manifestPath, { requireEntry: true })
        if (manifest.id !== entry.name) {
          throw new Error(`plugin id "${manifest.id}" must match directory name "${entry.name}"`)
        }
        if (this.records.has(manifest.id)) throw new Error(`duplicate plugin id: ${manifest.id}`)
        const record: PluginRecord = {
          manifest,
          trust: 'dev',
          dir,
          status: manifest.apiVersion === PLUGIN_API_VERSION ? 'inactive' : 'error',
          ...(manifest.apiVersion === PLUGIN_API_VERSION
            ? {}
            : { error: `requires apiVersion ${manifest.apiVersion}; host supports ${PLUGIN_API_VERSION}` }),
          panels: new Map(),
          tools: new Set(),
        }
        this.records.set(manifest.id, record)
      } catch (error) {
        this.loadErrors.push({ path: manifestPath, error: messageOf(error) })
      }
    }
  }

  private isEnabled(record: PluginRecord): boolean {
    return this.state.enabled[record.manifest.id] ?? record.trust === 'builtin'
  }

  private async activate(record: PluginRecord): Promise<void> {
    if (record.status === 'active' || record.status === 'activating') return
    if (record.manifest.apiVersion !== PLUGIN_API_VERSION) {
      record.status = 'error'
      record.error = `requires apiVersion ${record.manifest.apiVersion}; host supports ${PLUGIN_API_VERSION}`
      return
    }
    record.status = 'activating'
    record.error = undefined
    const runtime = new Runtime()
    record.runtime = runtime
    try {
      const module = await this.loadModule(record)
      const ctx = this.createContext(record, runtime)
      await withTimeout(
        Promise.resolve().then(() => module.activate(ctx)),
        ACTIVATE_TIMEOUT_MS,
        `plugin ${record.manifest.id} activation timed out`,
      )
      record.status = 'active'
    } catch (error) {
      record.status = 'error'
      record.error = messageOf(error)
      record.runtime = undefined
      await runtime.disposeAll()
      this.clearRegistrations(record)
      console.error(`[plugin] ${record.manifest.id} activation failed:`, error)
    }
  }

  private async deactivate(record: PluginRecord): Promise<void> {
    if (record.status !== 'active' && record.status !== 'activating') {
      this.clearRegistrations(record)
      return
    }
    const runtime = record.runtime
    const module = record.module
    let failure: string | undefined
    if (module?.deactivate) {
      try {
        await withTimeout(
          Promise.resolve().then(() => module.deactivate?.()),
          DEACTIVATE_TIMEOUT_MS,
          `plugin ${record.manifest.id} deactivation timed out`,
        )
      } catch (error) {
        failure = messageOf(error)
        console.error(`[plugin] ${record.manifest.id} deactivation failed:`, error)
      }
    }
    if (runtime) await runtime.disposeAll()
    record.runtime = undefined
    this.clearRegistrations(record)
    record.status = failure ? 'error' : 'inactive'
    record.error = failure
  }

  private clearRegistrations(record: PluginRecord): void {
    for (const tool of record.tools) this.options.tools.unregister(tool)
    record.tools.clear()
    record.panels.clear()
  }

  private async loadModule(record: PluginRecord): Promise<PluginModule> {
    if (record.module) return record.module
    if (!record.dir || !record.manifest.entry) throw new Error('plugin entry is missing')
    const entry = resolvePluginPath(record.dir, record.manifest.entry, 'entry')
    if (!statSync(entry, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`entry not found: ${record.manifest.entry}`)
    }
    const imported = await import(pathToFileURL(entry).href) as Record<string, unknown>
    const candidate = typeof imported.default === 'object' && imported.default !== null
      ? imported.default as Record<string, unknown>
      : imported
    if (typeof candidate.activate !== 'function') {
      throw new Error('plugin entry must export activate(ctx)')
    }
    const module: PluginModule = {
      activate: candidate.activate as PluginModule['activate'],
      ...(typeof candidate.deactivate === 'function'
        ? { deactivate: candidate.deactivate as PluginModule['deactivate'] }
        : {}),
    }
    record.module = module
    return module
  }

  private createContext(record: PluginRecord, runtime: Runtime): PluginContext {
    const manifest = record.manifest
    const dataDir = join(this.storageRoot, manifest.id)
    mkdirSync(dataDir, { recursive: true })
    const storage = new FilePluginStorage({ root: dataDir, label: manifest.id })

    const assertActive = (): void => {
      if (!runtime.active) throw new Error(`plugin ${manifest.id} is not active`)
    }
    const assertCapability = (capability: PluginCapability): void => {
      if (!manifest.capabilities.includes(capability)) {
        throw new Error(`plugin ${manifest.id} did not declare capability ${capability}`)
      }
    }
    const guardStorage = <T>(work: () => Promise<T>): Promise<T> => {
      assertActive()
      assertCapability('storage')
      return work()
    }

    const guardedStorage: PluginStorage = {
      get: key => guardStorage(() => storage.get(key)),
      set: (key, value) => guardStorage(() => storage.set(key, value)),
      delete: key => guardStorage(() => storage.delete(key)),
      keys: () => guardStorage(() => storage.keys()),
    }

    const log = {
      info: (message: string, ...args: unknown[]) => console.info(`[plugin:${manifest.id}] ${message}`, ...args),
      warn: (message: string, ...args: unknown[]) => console.warn(`[plugin:${manifest.id}] ${message}`, ...args),
      error: (message: string, ...args: unknown[]) => console.error(`[plugin:${manifest.id}] ${message}`, ...args),
    }

    const context: PluginContext = {
      plugin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        dataDir,
      },
      signal: runtime.controller.signal,
      tools: {
        register: (tool: ToolDefinition): PluginDisposable => {
          assertActive()
          assertCapability('tools.register')
          if (!tool || typeof tool !== 'object' || typeof tool.run !== 'function') {
            throw new Error('plugin tool must provide run(args, context)')
          }
          if (typeof tool.name !== 'string' || !tool.name.trim()) {
            throw new Error('plugin tool name must be a non-empty string')
          }
          if (tool.inputSchema === undefined || tool.inputSchema === null) {
            throw new Error('plugin tool must provide inputSchema')
          }
          if (tool.meta !== undefined
            && (typeof tool.meta !== 'object' || tool.meta === null || Array.isArray(tool.meta))) {
            throw new Error('plugin tool meta must be an object')
          }
          if (record.tools.size >= 64) throw new Error('plugin registered too many tools')
          const publicName = pluginToolName(manifest.id, tool.name)
          if (record.tools.has(publicName) || this.options.tools.get(publicName)) {
            throw new Error(`tool already registered: ${publicName}`)
          }
          const namespaced = Object.create(tool) as ToolDefinition
          Object.defineProperty(namespaced, 'name', {
            value: publicName,
            enumerable: true,
          })
          const sourceMeta = tool.meta ?? {}
          const requestedTimeout = sourceMeta.timeoutMs
          const timeoutMs = typeof requestedTimeout === 'number'
            && Number.isFinite(requestedTimeout)
            ? Math.min(Math.max(requestedTimeout, 1_000), 120_000)
            : 60_000
          const meta = {
            ...sourceMeta,
            // 插件不能自己决定无限跑；宿主封顶 120 秒。
            timeoutMs,
            // dev 插件不信任自报的 dangerous/readOnly；内置示例保留声明。
            ...(record.trust === 'dev' ? { dangerous: true, readOnly: false } : {}),
          }
          Object.defineProperty(namespaced, 'meta', {
            value: meta,
            enumerable: true,
          })
          Object.defineProperty(namespaced, 'run', {
            value: async (args: unknown, context: ToolContext) => {
              const result = await tool.run(args, context)
              if (!result || typeof result !== 'object' || Array.isArray(result)) {
                throw new Error(`plugin tool ${publicName} must return a ToolResult object`)
              }
              return result
            },
            enumerable: true,
          })
          const enabled = this.options.enabledTools?.has(publicName) === true
            && this.options.disabledTools?.has(publicName) !== true
          this.options.tools.register(namespaced, 'plugin', {
            enabled,
            approval: 'required',
          })
          record.tools.add(publicName)
          runtime.tools.add(publicName)
          const dispose = runtime.add(() => {
            record.tools.delete(publicName)
            runtime.tools.delete(publicName)
            this.options.tools.unregister(publicName)
          })
          const approval = this.options.toolApproval?.[publicName]
          if (approval) this.options.tools.update(publicName, { approval })
          return dispose
        },
      },
      ui: {
        registerPanel: (panel: PluginPanel): PluginDisposable => {
          assertActive()
          assertCapability('ui.panel')
          if (!panel || typeof panel !== 'object') throw new Error('panel must be an object')
          if (typeof panel.id !== 'string'
            || !PANEL_ID_PATTERN.test(panel.id)
            || panel.id.includes('..')) {
            throw new Error(`invalid panel id: ${String(panel.id)}`)
          }
          if (typeof panel.title !== 'string' || !panel.title.trim() || panel.title.length > 100) {
            throw new Error('panel title must be 1-100 characters')
          }
          if (typeof panel.html !== 'string' || Buffer.byteLength(panel.html, 'utf8') > PANEL_HTML_LIMIT) {
            throw new Error(`panel html exceeds ${PANEL_HTML_LIMIT} bytes`)
          }
          if (panel.slot !== undefined && panel.slot !== 'settings') {
            throw new Error('panel slot must be settings')
          }
          if (panel.width !== undefined && (!Number.isFinite(panel.width) || panel.width <= 0)) {
            throw new Error('panel width must be a positive number')
          }
          if (panel.height !== undefined && (!Number.isFinite(panel.height) || panel.height <= 0)) {
            throw new Error('panel height must be a positive number')
          }
          if (record.panels.size >= 16) throw new Error('plugin registered too many panels')
          if (record.panels.has(panel.id)) throw new Error(`panel already registered: ${panel.id}`)
          const normalized: PluginPanel = {
            id: panel.id,
            title: panel.title.trim(),
            html: withPanelCsp(panel.html),
            ...(panel.slot === 'settings' || panel.slot === 'right' ? { slot: panel.slot } : {}),
            ...(typeof panel.width === 'number' ? { width: panel.width } : {}),
            ...(typeof panel.height === 'number' ? { height: panel.height } : {}),
          }
          record.panels.set(panel.id, normalized)
          runtime.panels.add(panel.id)
          return runtime.add(() => {
            record.panels.delete(panel.id)
            runtime.panels.delete(panel.id)
          })
        },
      },
      storage: guardedStorage,
      assets: {
        read: async (path: string): Promise<string> => {
          assertActive()
          if (!record.dir) throw new Error('builtin plugins have no asset directory')
          return readPluginAsset(record.dir, path)
        },
      },
      log,
      effect: (effect: () => PluginDisposable | void): PluginDisposable => {
        assertActive()
        const result = effect()
        if (result !== undefined
          && typeof result !== 'function'
          && (typeof result !== 'object' || result === null || typeof result.dispose !== 'function')) {
          throw new Error('ctx.effect must return a function or an object with dispose()')
        }
        return runtime.add(result)
      },
    }
    return context
  }

  private mustGet(id: string): PluginRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`plugin not found: ${id}`)
    return record
  }

  private info(record: PluginRecord): PluginInfo {
    const enabled = this.isEnabled(record)
    const status = record.status === 'error'
      ? 'error'
      : enabled ? record.status : 'disabled'
    return {
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      apiVersion: record.manifest.apiVersion,
      ...(record.manifest.description ? { description: record.manifest.description } : {}),
      trust: record.trust,
      status,
      provides: record.manifest.provides,
      capabilities: record.manifest.capabilities,
      tools: [...record.tools],
      panels: [...record.panels.values()].map(panel => this.panelInfo(panel)),
      ...(record.error ? { error: record.error } : {}),
    }
  }

  private panelInfo(panel: PluginPanel): PluginPanelInfo {
    return {
      id: panel.id,
      title: panel.title,
      ...(panel.slot ? { slot: panel.slot } : {}),
      ...(panel.width !== undefined ? { width: panel.width } : {}),
      ...(panel.height !== undefined ? { height: panel.height } : {}),
    }
  }

  private loadState(): PluginState {
    if (!existsSync(this.statePath)) return { version: 1, enabled: {} }
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('state root must be an object')
      }
      const record = raw as { version?: unknown; enabled?: unknown }
      if (record.version !== 1
        || typeof record.enabled !== 'object'
        || record.enabled === null
        || Array.isArray(record.enabled)) {
        throw new Error('unsupported plugin state')
      }
      const enabled: Record<string, boolean> = {}
      for (const [id, value] of Object.entries(record.enabled as Record<string, unknown>)) {
        if (typeof value === 'boolean') enabled[id] = value
      }
      return { version: 1, enabled }
    } catch (error) {
      console.warn(`[plugin] state reset: ${messageOf(error)}`)
      return { version: 1, enabled: {} }
    }
  }

  private saveState(): void {
    mkdirSync(this.options.dataRoot, { recursive: true })
    const temp = `${this.statePath}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    renameSync(temp, this.statePath)
  }
}
