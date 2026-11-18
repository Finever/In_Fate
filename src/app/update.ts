/**
 * 内置更新器：安装布局、更新清单、下载暂存、pending 切换。
 *
 * 边界：
 *   - 布局是 In_First/In_Fate（程序） + In_First/data（数据）。
 *   - 运行中的进程不改自己的文件；只下载/解压到 In_First/.updates，
 *     写 pending.json，由启动脚本在下次启动前整体切换 In_Fate。
 *   - dataRoot 永远不动。
 *   - 没有配置更新源时，仍支持手动上传本地更新包。
 *
 * @module if/app/update
 */

import { createHash } from 'node:crypto'
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const UPDATE_MANIFEST_VERSION = 1
/** 单个更新包上限；超过直接拒绝，避免磁盘被拖满。 */
export const UPDATE_MAX_BYTES = 512 * 1024 * 1024
/** 解压后的总大小与文件数上限，防 zip bomb。 */
export const UPDATE_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
export const UPDATE_MAX_FILES = 200_000
const UPDATE_MANIFEST_MAX_BYTES = 1024 * 1024

export type UpdateLayout = 'dev' | 'portable' | 'installed'
export type UpdateJobState = 'idle' | 'checking' | 'downloading' | 'staging' | 'ready' | 'error'

export class UpdateError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
  }
}

export interface UpdateLayoutInfo {
  readonly layout: UpdateLayout
  /** 包根（便携/安装版）；开发环境是仓库根。 */
  readonly installRoot: string
  /** 当前程序层：In_First/In_Fate 或仓库根。 */
  readonly programRoot: string
  /** 程序层目录：安装版 In_First/In_Fate；开发环境没有。 */
  readonly appDir: string
  readonly dataRoot: string
  readonly currentVersion: string
}

export interface UpdateManifest {
  readonly version: string
  readonly url: string
  readonly sha256: string
  readonly size?: number
  readonly notes?: string
  readonly publishedAt?: string
}

export interface UpdateCheckResult {
  readonly currentVersion: string
  readonly manifest: UpdateManifest
  /** 按清单地址解析后的绝对下载地址。 */
  readonly resolvedUrl: string
  readonly available: boolean
}

export interface UpdateJob {
  readonly state: UpdateJobState
  readonly version?: string
  readonly downloaded: number
  readonly total?: number
  readonly error?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

export interface PendingUpdate {
  readonly action: 'apply' | 'rollback'
  readonly version: string
  readonly fromVersion: string
  /** apply 时相对 app 目录的暂存程序路径，例如 .updates/0.0.2/program */
  readonly program?: string
  readonly requestedAt: string
}

export interface UpdateStatus {
  readonly currentVersion: string
  readonly layout: UpdateLayout
  readonly installRoot: string
  readonly programRoot: string
  readonly appDir: string
  readonly dataRoot: string
  readonly manifestUrl?: string
  readonly pending?: PendingUpdate
  readonly previousVersion?: string
  readonly job: UpdateJob
}

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: string
}

function parseVersion(raw: string): ParsedVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (!match) throw new UpdateError('update_version', `版本号不合法：${raw}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  }
}

function comparePrerelease(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (numericX !== numericY) {
      return numericX ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 语义化版本比较；返回负数表示 a < b。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease === right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseUpdateManifest(raw: unknown): UpdateManifest {
  if (!isRecord(raw)) throw new UpdateError('update_manifest', '更新清单不是对象')
  const version = raw.version
  const url = raw.url
  const sha256 = raw.sha256
  if (typeof version !== 'string' || version.trim() === '') {
    throw new UpdateError('update_manifest', '更新清单缺少 version')
  }
  parseVersion(version)
  if (typeof url !== 'string' || url.trim() === '') {
    throw new UpdateError('update_manifest', '更新清单缺少 url')
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
    throw new UpdateError('update_manifest', '更新清单的 sha256 必须是 64 位十六进制')
  }
  const size = raw.size
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || size > UPDATE_MAX_BYTES)) {
    throw new UpdateError('update_manifest', '更新清单的 size 不合法')
  }
  const notes = raw.notes
  if (notes !== undefined && typeof notes !== 'string') {
    throw new UpdateError('update_manifest', '更新清单的 notes 必须是字符串')
  }
  const publishedAt = raw.publishedAt
  if (publishedAt !== undefined && typeof publishedAt !== 'string') {
    throw new UpdateError('update_manifest', '更新清单的 publishedAt 必须是字符串')
  }
  return {
    version: version.trim(),
    url: url.trim(),
    sha256: sha256.toLowerCase(),
    ...(size !== undefined ? { size } : {}),
    ...(notes !== undefined && notes !== '' ? { notes } : {}),
    ...(publishedAt !== undefined && publishedAt !== '' ? { publishedAt } : {}),
  }
}

/** 默认程序层：src/app/update.ts 的两级父目录（仓库根或 In_First/In_Fate）。 */
export function defaultProgramRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function resolveUpdateLayout(options: {
  readonly programRoot?: string
  readonly dataRoot: string
  readonly currentVersion: string
}): UpdateLayoutInfo {
  const programRoot = resolve(options.programRoot ?? defaultProgramRoot())
  const installRoot = dirname(programRoot)
  const packaged = basename(programRoot) === 'In_Fate'
    && existsSync(join(installRoot, 'config', 'if.release.json'))
  const installed = packaged && existsSync(join(installRoot, 'install.json'))
  return {
    layout: !packaged ? 'dev' : installed ? 'installed' : 'portable',
    installRoot: packaged ? installRoot : programRoot,
    programRoot,
    appDir: packaged ? programRoot : join(installRoot, 'In_Fate'),
    dataRoot: resolve(options.dataRoot),
    currentVersion: options.currentVersion,
  }
}

function manifestBaseUrl(manifestUrl: string): { href: string; isFile: boolean } {
  const raw = manifestUrl.trim()
  if (/^https?:\/\//i.test(raw)) return { href: raw, isFile: false }
  if (/^file:/i.test(raw)) return { href: raw, isFile: true }
  // Windows 盘符路径在 URL 里也会被当成 scheme，先识别出来。
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { href: pathToFileURL(resolve(raw)).href, isFile: true }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new UpdateError('update_source', `不支持的更新源协议：${raw}`)
  }
  return { href: pathToFileURL(resolve(raw)).href, isFile: true }
}

function readManifestText(href: string, isFile: boolean): Promise<string> {
  if (isFile) {
    const path = fileURLToPath(href)
    if (statSync(path).size > UPDATE_MANIFEST_MAX_BYTES) {
      throw new UpdateError('update_source', '更新清单过大')
    }
    return Promise.resolve(readFileSync(path, 'utf8'))
  }
  return new Promise((resolveText, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    fetch(href, { redirect: 'follow', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new UpdateError('update_source', `更新源返回 ${response.status}`)
        const length = Number(response.headers.get('content-length'))
        if (Number.isFinite(length) && length > UPDATE_MANIFEST_MAX_BYTES) {
          throw new UpdateError('update_source', '更新清单过大')
        }
        const text = await response.text()
        if (Buffer.byteLength(text, 'utf8') > UPDATE_MANIFEST_MAX_BYTES) {
          throw new UpdateError('update_source', '更新清单过大')
        }
        resolveText(text)
      })
      .catch(error => reject(error instanceof UpdateError
        ? error
        : new UpdateError('update_source', `读取更新源失败：${error instanceof Error ? error.message : String(error)}`)))
      .finally(() => clearTimeout(timer))
  })
}

export async function fetchUpdateManifest(
  manifestUrl: string,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  const base = manifestBaseUrl(manifestUrl)
  const text = await readManifestText(base.href, base.isFile)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new UpdateError('update_manifest', '更新清单不是合法 JSON')
  }
  const manifest = parseUpdateManifest(raw)
  let resolvedUrl: string
  try {
    const target = new URL(manifest.url, base.href)
    if (target.protocol !== 'http:' && target.protocol !== 'https:' && target.protocol !== 'file:') {
      throw new Error(`unsupported protocol ${target.protocol}`)
    }
    resolvedUrl = target.href
  } catch {
    throw new UpdateError('update_manifest', `更新包地址不合法：${manifest.url}`)
  }
  return {
    currentVersion,
    manifest,
    resolvedUrl,
    available: compareVersions(manifest.version, currentVersion) > 0,
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadToFile(
  url: string,
  dest: string,
  options: {
    readonly expectedSize?: number
    readonly maxBytes: number
    readonly signal?: AbortSignal
    readonly onProgress: (downloaded: number, total?: number) => void
  },
): Promise<void> {
  if (url.startsWith('file:')) {
    const source = fileURLToPath(url)
    const size = statSync(source).size
    if (size > options.maxBytes) throw new UpdateError('update_size', '更新包超过大小上限')
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(source, dest)
    options.onProgress(size, size)
    return
  }

  const response = await fetch(url, { redirect: 'follow', signal: options.signal })
  if (!response.ok || !response.body) {
    throw new UpdateError('update_download', `下载更新失败：${response.status} ${response.statusText}`)
  }
  const headerLength = Number(response.headers.get('content-length'))
  const total = Number.isFinite(headerLength) && headerLength > 0
    ? headerLength
    : options.expectedSize
  if (total !== undefined && total > options.maxBytes) {
    throw new UpdateError('update_size', '更新包超过大小上限')
  }

  mkdirSync(dirname(dest), { recursive: true })
  const writer = createWriteStream(dest)
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > options.maxBytes) {
        throw new UpdateError('update_size', '更新包超过大小上限')
      }
      if (!writer.write(value)) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          writer.once('drain', resolveDrain)
          writer.once('error', rejectDrain)
        })
      }
      options.onProgress(received, total)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    await new Promise<void>((resolveDone, reject) => {
      writer.end(() => resolveDone())
      writer.once('error', reject)
    })
  }
}

function windowsTar(): string {
  const systemRoot = process.env.SystemRoot
    ?? process.env.windir
    ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'tar.exe')
}

function powershell(): string {
  const systemRoot = process.env.SystemRoot
    ?? process.env.windir
    ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function runTool(command: string, args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolveRun => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    child.on('error', error => resolveRun({ ok: false, output: error.message }))
    child.on('exit', code => resolveRun({ ok: code === 0, output }))
  })
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function listZipEntries(zipPath: string): Promise<string[] | undefined> {
  const attempts = process.platform === 'win32'
    ? [{ command: windowsTar(), args: ['-tf', zipPath] }]
    : [
      { command: 'unzip', args: ['-Z1', zipPath] },
      { command: 'tar', args: ['-tf', zipPath] },
    ]
  for (const attempt of attempts) {
    const result = await runTool(attempt.command, attempt.args)
    if (!result.ok) continue
    return result.output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  }
  return undefined
}

function assertZipEntrySafe(entry: string): void {
  if (entry.startsWith('/') || entry.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(entry)) {
    throw new UpdateError('update_package', `更新包含绝对路径：${entry}`)
  }
  if (entry.split(/[\\/]/).some(part => part === '..')) {
    throw new UpdateError('update_package', `更新包含上级路径：${entry}`)
  }
}

/** 解压后兜底检查：拒绝符号链接、过大总字节和过多文件。 */
function checkExtractedTree(dir: string): void {
  let bytes = 0
  let files = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new UpdateError('update_package', `更新包含符号链接：${entry.name}`)
      }
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      files += 1
      if (files > UPDATE_MAX_FILES) {
        throw new UpdateError('update_package', '更新包文件数过多')
      }
      if (entry.isFile()) {
        bytes += statSync(full).size
        if (bytes > UPDATE_MAX_EXTRACTED_BYTES) {
          throw new UpdateError('update_package', '更新包解压后过大')
        }
      }
    }
  }
  walk(dir)
}

/** 解压 zip。Git Bash 的 GNU tar 不认 zip，所以 Windows 固定用 System32 的 bsdtar。 */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  const entries = await listZipEntries(zipPath)
  if (entries) {
    for (const entry of entries) assertZipEntrySafe(entry)
  }
  mkdirSync(dest, { recursive: true })
  const attempts: Array<{ command: string; args: readonly string[] }> = process.platform === 'win32'
    ? [
      { command: windowsTar(), args: ['-xf', zipPath, '-C', dest] },
      {
        command: powershell(),
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(dest)} -Force`,
        ],
      },
    ]
    : [
      { command: 'unzip', args: ['-q', zipPath, '-d', dest] },
      { command: 'tar', args: ['-xf', zipPath, '-C', dest] },
    ]
  const errors: string[] = []
  for (const attempt of attempts) {
    const result = await runTool(attempt.command, attempt.args)
    if (result.ok) {
      checkExtractedTree(dest)
      return
    }
    errors.push(`${basename(attempt.command)}: ${result.output.trim() || 'failed'}`)
  }
  throw new UpdateError('update_extract', `解压更新包失败：${errors.join('；')}`)
}

function looksLikeProgram(dir: string): boolean {
  return existsSync(join(dir, 'bin', 'if.ts')) && existsSync(join(dir, 'VERSION'))
}

/** 在解压目录里找程序层，最多下钻 4 层；更新包可能是完整发布包。 */
function findProgramDir(root: string, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (looksLikeProgram(root)) return root
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findProgramDir(join(root, entry.name), depth + 1)
    if (found) return found
  }
  return undefined
}

function readVersionFile(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function updatesDirOf(installRoot: string): string {
  return join(installRoot, '.updates')
}

export function readPendingUpdate(installRoot: string): PendingUpdate | undefined {
  const path = join(updatesDirOf(installRoot), 'pending.json')
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingUpdate>
    if ((raw.action !== 'apply' && raw.action !== 'rollback')
      || typeof raw.version !== 'string'
      || typeof raw.fromVersion !== 'string'
      || typeof raw.requestedAt !== 'string') {
      return undefined
    }
    return {
      action: raw.action,
      version: raw.version,
      fromVersion: raw.fromVersion,
      ...(typeof raw.program === 'string' ? { program: raw.program } : {}),
      requestedAt: raw.requestedAt,
    }
  } catch {
    return undefined
  }
}

export interface UpdateServiceOptions {
  readonly layout: UpdateLayoutInfo
  readonly manifestUrl?: string
  readonly now?: () => Date
}

export class UpdateService {
  readonly layout: UpdateLayoutInfo
  private manifestUrl: string | undefined
  private readonly now: () => Date
  private jobState: UpdateJob = { state: 'idle', downloaded: 0 }
  private controller: AbortController | undefined
  private disposed = false

  constructor(options: UpdateServiceOptions) {
    this.layout = options.layout
    this.manifestUrl = options.manifestUrl?.trim() || undefined
    this.now = options.now ?? ((): Date => new Date())
    this.restoreReadyFromDisk()
  }

  /** 进程重启后把已下载好的暂存恢复成 ready，避免用户只能重下。 */
  private restoreReadyFromDisk(): void {
    if (this.layout.layout === 'dev') return
    const updatesDir = updatesDirOf(this.layout.installRoot)
    let best: { version: string; program: string; mtime: number; size: number } | undefined
    try {
      for (const entry of readdirSync(updatesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(updatesDir, entry.name)
        const program = join(dir, 'program')
        if (!looksLikeProgram(program)) continue
        const version = readVersionFile(program)
        if (!version) continue
        if (compareVersions(version, this.layout.currentVersion) <= 0) continue
        let mtime = 0
        let size = 0
        try {
          mtime = statSync(dir).mtimeMs
          size = statSync(join(dir, 'package.zip')).size
        } catch {
          // 手动上传的暂存没有 package.zip
        }
        if (!best || mtime > best.mtime) {
          best = { version, program, mtime, size }
        }
      }
    } catch {
      return
    }
    if (!best) return
    this.jobState = {
      state: 'ready',
      version: best.version,
      downloaded: best.size,
      ...(best.size > 0 ? { total: best.size } : {}),
      finishedAt: this.now().toISOString(),
    }
  }

  setManifestUrl(url: string | undefined): void {
    this.manifestUrl = url?.trim() || undefined
  }

  job(): UpdateJob {
    return this.jobState
  }

  status(): UpdateStatus {
    const previous = this.previousVersion()
    const pending = readPendingUpdate(this.layout.installRoot)
    return {
      currentVersion: this.layout.currentVersion,
      layout: this.layout.layout,
      installRoot: this.layout.installRoot,
      programRoot: this.layout.programRoot,
      appDir: this.layout.appDir,
      dataRoot: this.layout.dataRoot,
      ...(this.manifestUrl ? { manifestUrl: this.manifestUrl } : {}),
      ...(pending ? { pending } : {}),
      ...(previous ? { previousVersion: previous } : {}),
      job: this.jobState,
    }
  }

  private previousVersion(): string | undefined {
    if (this.layout.layout === 'dev') return undefined
    const dir = join(this.layout.installRoot, 'previous')
    return existsSync(dir) ? readVersionFile(dir) : undefined
  }

  private assertUpdatable(): void {
    if (this.layout.layout === 'dev') {
      throw new UpdateError('update_unsupported', '开发环境不支持应用更新；请使用发布包或安装版')
    }
  }

  async check(): Promise<UpdateCheckResult> {
    if (!this.manifestUrl) {
      throw new UpdateError('update_no_source', '还没有配置更新源')
    }
    return fetchUpdateManifest(this.manifestUrl, this.layout.currentVersion)
  }

  /** 下载并暂存；立即返回 job，前端轮询 job()。 */
  startDownload(): UpdateJob {
    this.assertUpdatable()
    if (this.jobState.state === 'checking'
      || this.jobState.state === 'downloading'
      || this.jobState.state === 'staging') {
      return this.jobState
    }
    const startedAt = this.now().toISOString()
    this.jobState = { state: 'checking', downloaded: 0, startedAt }
    void this.downloadAndStage().catch(() => undefined)
    return this.jobState
  }

  private updateJob(patch: Partial<UpdateJob>): void {
    this.jobState = { ...this.jobState, ...patch }
  }

  private async downloadAndStage(): Promise<void> {
    try {
      const checked = await this.check()
      if (!checked.available) {
        throw new UpdateError('update_current', `已经是最新版本 ${this.layout.currentVersion}`)
      }
      const manifest = checked.manifest
      const updatesDir = updatesDirOf(this.layout.installRoot)
      const target = join(updatesDir, manifest.version)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      const zipPath = join(target, 'package.zip')

      this.controller = new AbortController()
      this.updateJob({
        state: 'downloading',
        version: manifest.version,
        downloaded: 0,
        ...(manifest.size ? { total: manifest.size } : {}),
      })
      await downloadToFile(checked.resolvedUrl, zipPath, {
        ...(manifest.size ? { expectedSize: manifest.size } : {}),
        maxBytes: UPDATE_MAX_BYTES,
        signal: this.controller.signal,
        onProgress: downloaded => this.updateJob({ downloaded }),
      })

      this.updateJob({ state: 'staging' })
      const actual = await sha256File(zipPath)
      if (actual !== manifest.sha256) {
        rmSync(target, { recursive: true, force: true })
        throw new UpdateError(
          'update_checksum',
          `更新包校验失败：期望 ${manifest.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
        )
      }
      const program = await this.stageZip(zipPath, manifest.version, target)
      writeFileSync(join(target, 'update.json'), `${JSON.stringify({
        version: manifest.version,
        sha256: actual,
        url: checked.resolvedUrl,
        ...(manifest.notes ? { notes: manifest.notes } : {}),
        stagedAt: this.now().toISOString(),
      }, null, 2)}\n`, 'utf8')
      this.updateJob({
        state: 'ready',
        version: manifest.version,
        downloaded: statSync(zipPath).size,
        finishedAt: this.now().toISOString(),
      })
    } catch (error) {
      this.updateJob({
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: this.now().toISOString(),
      })
    }
  }

  /** 手动上传或本地路径：解压、校验、暂存。 */
  async stagePackage(zipPath: string, expectedVersion?: string): Promise<{ version: string; program: string }> {
    this.assertUpdatable()
    const size = statSync(zipPath).size
    if (size > UPDATE_MAX_BYTES) throw new UpdateError('update_size', '更新包超过大小上限')
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const target = join(updatesDirOf(this.layout.installRoot), `manual-${stamp}`)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    try {
      const program = await this.stageZip(zipPath, expectedVersion, target)
      const version = readVersionFile(program)
      if (!version) throw new UpdateError('update_package', '更新包里没有 VERSION')
      if (expectedVersion && version !== expectedVersion) {
        throw new UpdateError('update_package', `版本不匹配：期望 ${expectedVersion}，实际 ${version}`)
      }
      if (!expectedVersion && compareVersions(version, this.layout.currentVersion) < 0) {
        throw new UpdateError(
          'update_downgrade',
          `本地更新包 V${version} 低于当前 V${this.layout.currentVersion}，不允许降级`,
        )
      }
      this.jobState = {
        state: 'ready',
        version,
        downloaded: size,
        total: size,
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
      }
      return { version, program }
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
  }

  private async stageZip(
    zipPath: string,
    expectedVersion: string | undefined,
    targetDir: string,
  ): Promise<string> {
    const extractDir = join(targetDir, 'extracted')
    rmSync(extractDir, { recursive: true, force: true })
    await extractZip(zipPath, extractDir)
    const found = findProgramDir(extractDir)
    if (!found) throw new UpdateError('update_package', '更新包里找不到程序层（bin/if.ts + VERSION）')
    const version = readVersionFile(found)
    if (!version) throw new UpdateError('update_package', '更新包里没有 VERSION')
    if (expectedVersion && version !== expectedVersion) {
      throw new UpdateError('update_package', `更新包版本不匹配：期望 ${expectedVersion}，实际 ${version}`)
    }
    const program = join(targetDir, 'program')
    rmSync(program, { recursive: true, force: true })
    renameSync(found, program)
    rmSync(extractDir, { recursive: true, force: true })
    return program
  }

  /** 找到最近一次 ready 的暂存程序。 */
  private readyProgram(): { version: string; program: string } {
    const job = this.jobState
    if (job.state !== 'ready' || !job.version) {
      throw new UpdateError('update_not_ready', '还没有下载好的更新包')
    }
    const updatesDir = updatesDirOf(this.layout.installRoot)
    let candidates: string[] = []
    try {
      candidates = readdirSync(updatesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(updatesDir, entry.name))
    } catch {
      candidates = []
    }
    for (const dir of candidates) {
      const program = join(dir, 'program')
      if (looksLikeProgram(program) && readVersionFile(program) === job.version) {
        return { version: job.version, program }
      }
    }
    throw new UpdateError('update_not_ready', '暂存目录已丢失，请重新下载')
  }

  requestApply(): PendingUpdate {
    this.assertUpdatable()
    const ready = this.readyProgram()
    const updatesDir = updatesDirOf(this.layout.installRoot)
    const programRel = relative(this.layout.installRoot, ready.program)
    if (programRel.startsWith('..') || programRel.includes(`..${sep}`)) {
      throw new UpdateError('update_package', '暂存路径越界')
    }
    const pending: PendingUpdate = {
      action: 'apply',
      version: ready.version,
      fromVersion: this.layout.currentVersion,
      program: programRel.split(sep).join('/'),
      requestedAt: this.now().toISOString(),
    }
    const file = join(updatesDir, 'pending.json')
    mkdirSync(updatesDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`, 'utf8')
    return pending
  }

  requestRollback(): PendingUpdate {
    this.assertUpdatable()
    const previous = this.previousVersion()
    if (!previous) throw new UpdateError('update_no_previous', '没有可回滚的上一版本')
    const pending: PendingUpdate = {
      action: 'rollback',
      version: previous,
      fromVersion: this.layout.currentVersion,
      requestedAt: this.now().toISOString(),
    }
    const file = join(updatesDirOf(this.layout.installRoot), 'pending.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`, 'utf8')
    return pending
  }

  dispose(): void {
    this.disposed = true
    this.controller?.abort()
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}
