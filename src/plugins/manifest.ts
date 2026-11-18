/**
 * 插件清单与路径校验。
 *
 * 这里只做静态契约：字段、版本、能力声明、路径是否越界。
 * 运行期错误由 PluginRegistry 隔离，不在这里吞掉。
 *
 * @module if/plugins/manifest
 */

import { readFile } from 'node:fs/promises'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type {
  PluginCapability,
  PluginKind,
  PluginManifest,
} from './types.ts'

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KINDS = new Set<PluginKind>(['tool', 'ui-panel'])
const CAPABILITIES = new Set<PluginCapability>(['tools.register', 'ui.panel', 'storage'])

export class PluginManifestError extends Error {
  readonly issues: readonly string[]

  constructor(source: string, issues: readonly string[]) {
    super(`${source}: ${issues.join('; ')}`)
    this.name = 'PluginManifestError'
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(
  raw: Record<string, unknown>,
  key: string,
  issues: string[],
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  const value = raw[key]
  if (value === undefined) {
    if (options.required) issues.push(`${key} is required`)
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(`${key} must be a non-empty string`)
    return undefined
  }
  if (options.max !== undefined && value.length > options.max) {
    issues.push(`${key} is too long (max ${options.max})`)
  }
  return value.trim()
}

/** 逻辑路径：相对、正斜杠、不能跳出插件目录。 */
function validRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\')) return false
  // 允许开发者写 ./index.mjs，但 . 和 .. 不能出现在任何一段里。
  const normalized = path.replace(/^(?:\.\/)+/, '')
  if (!normalized) return false
  const parts = normalized.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

function parseKinds(raw: Record<string, unknown>, issues: string[]): PluginKind[] {
  if (!Array.isArray(raw.provides) || raw.provides.length === 0) {
    issues.push('provides must be a non-empty array')
    return []
  }
  const out: PluginKind[] = []
  for (const value of raw.provides) {
    if (typeof value !== 'string' || !KINDS.has(value as PluginKind)) {
      issues.push(`provides contains unknown kind: ${String(value)}`)
      continue
    }
    if (!out.includes(value as PluginKind)) out.push(value as PluginKind)
  }
  return out
}

function parseCapabilities(raw: Record<string, unknown>, issues: string[]): PluginCapability[] {
  if (!Array.isArray(raw.capabilities)) {
    issues.push('capabilities must be an array')
    return []
  }
  const out: PluginCapability[] = []
  for (const value of raw.capabilities) {
    if (typeof value !== 'string' || !CAPABILITIES.has(value as PluginCapability)) {
      issues.push(`capabilities contains unknown capability: ${String(value)}`)
      continue
    }
    if (!out.includes(value as PluginCapability)) out.push(value as PluginCapability)
  }
  return out
}

/**
 * 解析并校验 plugin.json。
 * @param raw 原始 JSON
 * @param source 报错来源路径
 * @param options.requireEntry dev 插件必须给入口；builtin 可以内联
 */
export function parsePluginManifest(
  raw: unknown,
  source: string,
  options: { requireEntry?: boolean } = {},
): PluginManifest {
  if (!isRecord(raw)) throw new PluginManifestError(source, ['manifest must be an object'])
  const issues: string[] = []

  const id = stringField(raw, 'id', issues, { required: true })
  if (id && (!ID_PATTERN.test(id) || id.includes('..'))) {
    issues.push('id must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63} and must not contain ".."')
  }
  const name = stringField(raw, 'name', issues, { required: true, max: 100 })
  const version = stringField(raw, 'version', issues, { required: true, max: 40 })
  if (version && !VERSION_PATTERN.test(version)) {
    issues.push('version must look like 1.2.3, optionally with -tag or +build')
  }
  const apiVersion = raw.apiVersion
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1) {
    issues.push('apiVersion must be a positive integer')
  }
  const entry = stringField(raw, 'entry', issues, { max: 500 })
  if (options.requireEntry && !entry) issues.push('entry is required for dev plugins')
  if (entry && !validRelativePath(entry)) {
    issues.push('entry must be a relative posix path without . or .. segments')
  }
  if (entry && !/\.(?:mjs|js)$/.test(entry)) {
    issues.push('entry must be a .js or .mjs module')
  }
  const description = stringField(raw, 'description', issues, { max: 500 })
  const provides = parseKinds(raw, issues)
  const capabilities = parseCapabilities(raw, issues)

  if (provides.includes('tool') && !capabilities.includes('tools.register')) {
    issues.push('provides "tool" requires capability "tools.register"')
  }
  if (provides.includes('ui-panel') && !capabilities.includes('ui.panel')) {
    issues.push('provides "ui-panel" requires capability "ui.panel"')
  }
  if (capabilities.includes('tools.register') && !provides.includes('tool')) {
    issues.push('capability "tools.register" requires provides "tool"')
  }
  if (capabilities.includes('ui.panel') && !provides.includes('ui-panel')) {
    issues.push('capability "ui.panel" requires provides "ui-panel"')
  }

  if (issues.length > 0) throw new PluginManifestError(source, issues)

  return {
    id: id!,
    name: name!,
    version: version!,
    apiVersion: apiVersion as number,
    ...(entry ? { entry } : {}),
    ...(description ? { description } : {}),
    provides,
    capabilities,
  }
}

function insideRoot(root: string, target: string): boolean {
  const left = process.platform === 'win32' ? root.toLowerCase() : root
  const right = process.platform === 'win32' ? target.toLowerCase() : target
  return right === left || right.startsWith(`${left}${sep}`)
}

/**
 * 把插件内的逻辑路径解析成绝对路径，并保证不越界。
 * 目标存在时还会校验 realpath，防止 symlink 逃逸。
 */
export function resolvePluginPath(root: string, relative: string, label: string): string {
  if (!validRelativePath(relative)) {
    throw new Error(`${label}: invalid relative path: ${relative}`)
  }
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, relative)
  if (!insideRoot(absoluteRoot, target)) {
    throw new Error(`${label}: path escapes plugin directory: ${relative}`)
  }
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${label}: symlinks are not allowed: ${relative}`)
  }
  if (statSync(target, { throwIfNoEntry: false })?.isFile()) {
    const realRoot = realpathSync(absoluteRoot)
    const realTarget = realpathSync(target)
    if (!insideRoot(realRoot, realTarget)) {
      throw new Error(`${label}: path escapes plugin directory: ${relative}`)
    }
  }
  return target
}

/** 读插件包内资源；只读、限插件目录。 */
export async function readPluginAsset(root: string, relative: string): Promise<string> {
  const target = resolvePluginPath(root, relative, 'asset')
  const stat = statSync(target, { throwIfNoEntry: false })
  if (!stat?.isFile()) throw new Error(`asset not found: ${relative}`)
  return readFile(target, 'utf8')
}

/** 工具名要和模型 API 兼容，也要避免插件之间撞名。 */
export function pluginToolName(pluginId: string, toolName: string): string {
  const segment = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'plugin'
  const name = `${segment(pluginId)}__${segment(toolName)}`
  if (name.length > 64) throw new Error(`tool name too long: ${name}`)
  return name
}
