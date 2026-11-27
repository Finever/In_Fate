import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '..')
const isWindows = process.platform === 'win32'
const INSTALLER_SCHEMA = 2
const DEFAULT_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\In_Fate'
const WIN_INTEGRATION_SCRIPT = 'windows-install.ps1'

function parseArgs(argv) {
  const options = {
    dir: undefined,
    dataDir: undefined,
    portable: false,
    shortcuts: true,
    registry: true,
    uninstall: false,
    purge: false,
    force: false,
    quiet: false,
    repair: false,
    dryRun: false,
    fromRegistry: false,
    launch: process.stdout.isTTY === true,
    launchExplicit: false,
    desktopDir: process.env.IF_INSTALL_DESKTOP_DIR,
    startMenuDir: process.env.IF_INSTALL_START_MENU_DIR,
    registryKey: process.env.IF_INSTALL_REGISTRY_KEY,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dir') options.dir = argv[++index]
    else if (arg === '--data-dir') options.dataDir = argv[++index]
    else if (arg === '--portable') options.portable = true
    else if (arg === '--repair') options.repair = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-shortcuts') options.shortcuts = false
    else if (arg === '--no-registry') options.registry = false
    else if (arg === '--desktop-dir') options.desktopDir = argv[++index]
    else if (arg === '--start-menu-dir') options.startMenuDir = argv[++index]
    else if (arg === '--registry-key') options.registryKey = argv[++index]
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--purge') options.purge = true
    else if (arg === '--force') options.force = true
    else if (arg === '--from-registry') options.fromRegistry = true
    else if (arg === '--launch') {
      options.launch = true
      options.launchExplicit = true
    } else if (arg === '--no-launch') {
      options.launch = false
      options.launchExplicit = true
    } else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function defaultInstallDir() {
  return join(homedir(), 'In_First')
}

function say(message, quiet) {
  if (!quiet) console.log(message)
}

function warn(message) {
  console.warn(`[install] ${message}`)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readVersion(dir) {
  const text = readText(join(dir, 'VERSION'))
  return text?.trim() || undefined
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  // Windows 批处理/脚本用 CRLF，避免 CMD/WSH 的换行解析问题。
  const content = /\.(cmd|vbs)$/i.test(path) ? text.replace(/\r?\n/g, '\r\n') : text
  writeFileSync(path, content, 'utf8')
}

function logLine(installDir, message) {
  try {
    mkdirSync(join(installDir, 'logs'), { recursive: true })
    appendFileSync(
      join(installDir, 'logs', 'install.log'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8',
    )
  } catch {
    // 日志失败不影响安装
  }
}

function pathKey(value) {
  const absolute = resolve(value)
  const normalized = isWindows ? absolute.replaceAll('/', '\\') : absolute
  return isWindows ? normalized.toLowerCase() : normalized
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

function inside(base, target) {
  const rel = relative(pathKey(base), pathKey(target))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isDriveRoot(value) {
  return samePath(value, parse(resolve(value)).root)
}

function systemRoot() {
  return process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
}

function powershellPath() {
  const exe = join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(exe)) throw new Error(`找不到 PowerShell：${exe}`)
  return exe
}

function cmdPath() {
  return process.env.ComSpec ?? join(systemRoot(), 'System32', 'cmd.exe')
}

function wscriptPath() {
  const exe = join(systemRoot(), 'System32', 'wscript.exe')
  if (!existsSync(exe)) throw new Error(`找不到 wscript.exe：${exe}`)
  return exe
}

function toPowerShellRegistryPath(key) {
  const raw = key.trim()
  if (/^(HKCU|HKLM|HKCR|HKU|HKCC):/i.test(raw)) return raw
  return raw.replace(/^(HKCU|HKLM|HKCR|HKU|HKCC)\\/i, '$1:\\')
}

function readHomeFile(installDir) {
  const text = readText(join(installDir, 'if-home.txt'))
  return text?.split(/\r?\n/)[0]?.trim() || undefined
}

function assertWritable(dir) {
  mkdirSync(dir, { recursive: true })
  const probe = join(dir, `.if-write-probe-${process.pid}-${randomUUID().slice(0, 8)}`)
  try {
    writeFileSync(probe, 'ok', 'utf8')
  } finally {
    rmSync(probe, { force: true })
  }
}

function removePath(path, quiet) {
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch (error) {
    say(
      `[uninstall] 暂时无法删除 ${path}：${error instanceof Error ? error.message : String(error)}`,
      quiet,
    )
    return false
  }
}

function copyTools(sourceRootDir, installDir) {
  if (samePath(sourceRootDir, installDir)) return
  for (const name of ['apply-pending.mjs', 'install.mjs', WIN_INTEGRATION_SCRIPT]) {
    const from = join(sourceRootDir, 'tools', name)
    if (!existsSync(from)) {
      if (name === WIN_INTEGRATION_SCRIPT) continue
      throw new Error(`发布包缺少 tools/${name}`)
    }
    mkdirSync(join(installDir, 'tools'), { recursive: true })
    cpSync(from, join(installDir, 'tools', name), { force: true })
  }
}

function validateSourcePackage(sourceProgram, options) {
  if (!existsSync(join(sourceProgram, 'bin', 'if.ts'))) {
    throw new Error(`这个目录不是完整发布包：找不到 ${join(sourceProgram, 'bin', 'if.ts')}`)
  }
  if (!existsSync(join(sourceRoot, 'config', 'if.release.json'))) {
    throw new Error(`发布包缺少配置模板：${join(sourceRoot, 'config', 'if.release.json')}`)
  }
  if (isWindows && (options.shortcuts || options.registry)) {
    const integrationScript = join(sourceRoot, 'tools', WIN_INTEGRATION_SCRIPT)
    if (!existsSync(integrationScript)) {
      throw new Error(`发布包缺少 Windows 安装集成脚本：${integrationScript}`)
    }
  }
}

function validatePaths({ installDir, dataDir, sourceProgram, inPlace, force, repairing }) {
  if (isDriveRoot(installDir)) {
    throw new Error(`不能安装到磁盘根目录：${installDir}`)
  }
  if (!inPlace && inside(sourceProgram, installDir)) {
    throw new Error(`安装目录不能放在程序目录里面：${installDir}`)
  }
  if (samePath(dataDir, sourceProgram) || inside(sourceProgram, dataDir)) {
    throw new Error(`数据目录不能放在程序目录里面：${dataDir}`)
  }
  if (!inPlace && inside(installDir, sourceRoot) && !samePath(sourceRoot, installDir)) {
    throw new Error(`安装目录不能包含发布包：${installDir}`)
  }

  if (repairing) return
  if (inPlace || !existsSync(installDir)) return
  let entries = []
  try {
    entries = readdirSync(installDir)
  } catch {
    throw new Error(`目标路径不是目录：${installDir}`)
  }
  const looksLikeIfRoot = existsSync(join(installDir, 'install.json'))
    || existsSync(join(installDir, 'In_Fate'))
    || existsSync(join(installDir, 'data'))
    || existsSync(join(installDir, 'config', 'if.release.json'))
  if (entries.length > 0 && !looksLikeIfRoot && !force) {
    throw new Error(`目标目录不是 In_First 安装根：${installDir}；换 --dir 或加 --force`)
  }
}

function startIfCmd() {
  return `@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "IF_HOME="
for /f "usebackq delims=" %%i in ("%~dp0if-home.txt") do if not defined IF_HOME set "IF_HOME=%%i"
if not defined IF_HOME set "IF_HOME=%~dp0data"
set "IF_CONFIG=%~dp0config\\if.release.json"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0tools\\apply-pending.mjs" "%~dp0"
if errorlevel 1 (
  pause
  exit /b 1
)
"%NODE%" "%~dp0In_Fate\\bin\\if.ts" serve -c "%IF_CONFIG%" --port 8787 --ui-dir "%~dp0In_Fate\\ui\\dist"
if errorlevel 1 pause
`
}

function startDesktopCmd() {
  return `@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0In_Fate\\desktop\\run.mjs" (
  echo In_Fate desktop files are missing. Use start-if.cmd instead.
  pause
  exit /b 1
)
set "IF_HOME="
for /f "usebackq delims=" %%i in ("%~dp0if-home.txt") do if not defined IF_HOME set "IF_HOME=%%i"
if not defined IF_HOME set "IF_HOME=%~dp0data"
set "IF_CONFIG=%~dp0config\\if.release.json"
if exist "%~dp0runtime\\node.exe" (
  set "IF_NODE=%~dp0runtime\\node.exe"
) else (
  set "IF_NODE=node"
)
"%IF_NODE%" "%~dp0tools\\apply-pending.mjs" "%~dp0"
if errorlevel 1 (
  pause
  exit /b 1
)
"%IF_NODE%" "%~dp0In_Fate\\desktop\\run.mjs"
if errorlevel 1 pause
`
}

function uninstallCmd() {
  return `@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "WAIT=1"
if /i "%~1"=="--from-registry" set "WAIT="
set "PURGE="
if /i "%~1"=="--purge" set "PURGE=--purge"
if /i "%~2"=="--purge" set "PURGE=--purge"
set "QUIET="
if /i "%~1"=="--quiet" set "QUIET=--quiet"
if /i "%~2"=="--quiet" set "QUIET=--quiet"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0tools\\install.mjs" --uninstall --dir "%~dp0" %PURGE% %QUIET%
if errorlevel 1 (
  echo.
  echo Uninstall failed. Press any key to close.
  pause
  exit /b 1
)
if defined WAIT pause
`
}

function repairCmd() {
  return `@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0tools\\install.mjs" --repair --dir "%~dp0" %*
if errorlevel 1 (
  echo.
  echo Repair failed. Press any key to close.
  pause
  exit /b 1
)
if /i "%~1"=="--quiet" exit /b 0
if /i "%~2"=="--quiet" exit /b 0
pause
`
}

function startIfSh() {
  return `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
IF_HOME=$(head -n 1 if-home.txt 2>/dev/null || true)
[ -n "$IF_HOME" ] || IF_HOME="$PWD/data"
export IF_HOME
export IF_CONFIG="$PWD/config/if.release.json"
if [ -x ./runtime/node ]; then NODE=./runtime/node; else NODE=node; fi
"$NODE" tools/apply-pending.mjs "$PWD"
exec "$NODE" In_Fate/bin/if.ts serve -c config/if.release.json --port 8787 --ui-dir In_Fate/ui/dist
`
}

function startDesktopSh() {
  return `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
IF_HOME=$(head -n 1 if-home.txt 2>/dev/null || true)
[ -n "$IF_HOME" ] || IF_HOME="$PWD/data"
export IF_HOME
export IF_CONFIG="$PWD/config/if.release.json"
if [ -x ./runtime/node ]; then
  export IF_NODE="$PWD/runtime/node"
  ./runtime/node tools/apply-pending.mjs "$PWD"
  exec ./runtime/node In_Fate/desktop/run.mjs
else
  export IF_NODE=node
  node tools/apply-pending.mjs "$PWD"
  exec node In_Fate/desktop/run.mjs
fi
`
}

function startIfVbs() {
  return `Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run Chr(34) & base & "\\start-if.cmd" & Chr(34), 0, False
`
}

function startDesktopVbs() {
  return `Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run Chr(34) & base & "\\start-desktop.cmd" & Chr(34), 0, False
`
}

function writeLaunchers(installDir, dataDir, hasDesktop) {
  writeText(join(installDir, 'if-home.txt'), `${dataDir}\n`)
  writeText(join(installDir, 'start-if.cmd'), startIfCmd())
  writeText(join(installDir, 'start-if.sh'), startIfSh())
  if (isWindows) {
    writeText(join(installDir, 'uninstall.cmd'), uninstallCmd())
    writeText(join(installDir, 'repair.cmd'), repairCmd())
    writeText(join(installDir, 'start-if.vbs'), startIfVbs())
  }

  if (hasDesktop) {
    writeText(join(installDir, 'start-desktop.cmd'), startDesktopCmd())
    writeText(join(installDir, 'start-desktop.sh'), startDesktopSh())
    if (isWindows) writeText(join(installDir, 'start-desktop.vbs'), startDesktopVbs())
  } else {
    for (const name of ['start-desktop.cmd', 'start-desktop.sh', 'start-desktop.vbs']) {
      rmSync(join(installDir, name), { force: true })
    }
  }
  if (!isWindows) {
    for (const name of ['start-if.sh', 'start-desktop.sh']) {
      const path = join(installDir, name)
      if (existsSync(path)) chmodSync(path, 0o755)
    }
  }
}

function runWindowsAction(action, context) {
  if (!isWindows) return { skipped: true, action, shortcuts: [], registry: null }
  const script = join(sourceRoot, 'tools', WIN_INTEGRATION_SCRIPT)
  if (!existsSync(script)) {
    throw new Error(`找不到 Windows 安装集成脚本：${script}`)
  }
  const resultPath = join(tmpdir(), `if-install-${process.pid}-${randomUUID()}.json`)
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    action,
    '-InstallDir',
    context.installDir,
    '-Version',
    context.version ?? '0.0.0',
    '-Icon',
    context.icon ?? '',
    '-RegistryKey',
    toPowerShellRegistryPath(context.registryKey ?? DEFAULT_REGISTRY_KEY),
    '-ResultPath',
    resultPath,
  ]
  if (context.desktopDir) args.push('-DesktopDir', context.desktopDir)
  if (context.startMenuDir) args.push('-StartMenuDir', context.startMenuDir)
  if (context.shortcuts === false) args.push('-NoShortcuts')
  if (context.registry === false) args.push('-NoRegistry')

  const outcome = spawnSync(powershellPath(), args, { encoding: 'utf8', windowsHide: true })
  const parsed = readJson(resultPath)
  rmSync(resultPath, { force: true })

  if (outcome.error) {
    throw new Error(`无法启动 PowerShell：${outcome.error.message}`)
  }
  if (outcome.status !== 0 || !parsed?.ok) {
    const details = Array.isArray(parsed?.errors) && parsed.errors.length > 0
      ? parsed.errors.join('；')
      : (outcome.stderr ?? '').trim() || `PowerShell 退出码 ${outcome.status ?? '(未知)'}`
    throw new Error(Array.isArray(parsed?.warnings) && parsed.warnings.length > 0
      ? `${details}（${parsed.warnings.join('；')}）`
      : details)
  }
  return parsed
}

function integrationEnabled(options) {
  return isWindows && (options.shortcuts || options.registry)
}

function integrationContext(options, installDir, version, icon) {
  return {
    installDir,
    version,
    icon,
    desktopDir: options.desktopDir ? resolve(options.desktopDir) : undefined,
    startMenuDir: options.startMenuDir ? resolve(options.startMenuDir) : undefined,
    registryKey: options.registryKey ?? DEFAULT_REGISTRY_KEY,
    shortcuts: options.shortcuts,
    registry: options.registry,
  }
}

function writeInstallInfo(installDir, info) {
  writeText(join(installDir, 'install.json'), `${JSON.stringify(info, null, 2)}\n`)
}

function deployProgram(sourceProgram, targetProgram, targetPrevious, installDir, quiet) {
  const staging = join(installDir, `.install-staging-${process.pid}-${randomUUID().slice(0, 8)}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    cpSync(sourceProgram, staging, { recursive: true })
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  if (!existsSync(join(staging, 'bin', 'if.ts'))) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`复制后的程序不完整：${join(staging, 'bin', 'if.ts')}`)
  }

  const hadTarget = existsSync(targetProgram)
  if (hadTarget) {
    rmSync(targetPrevious, { recursive: true, force: true })
    try {
      renameSync(targetProgram, targetPrevious)
    } catch {
      try {
        cpSync(targetProgram, targetPrevious, { recursive: true })
        rmSync(targetProgram, { recursive: true, force: true })
      } catch (error) {
        rmSync(staging, { recursive: true, force: true })
        throw new Error(`旧版本备份失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  try {
    renameSync(staging, targetProgram)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (hadTarget && existsSync(targetPrevious) && !existsSync(targetProgram)) {
      try {
        renameSync(targetPrevious, targetProgram)
      } catch {
        try {
          cpSync(targetPrevious, targetProgram, { recursive: true })
        } catch {
          // 回滚失败保留 previous/，仍可手动恢复。
        }
      }
    }
    throw new Error(`程序切换失败：${error instanceof Error ? error.message : String(error)}`)
  }

  say(`[install] 程序已切换到 ${targetProgram}`, quiet)
  return { hadTarget }
}

function rollbackProgram(targetProgram, targetPrevious) {
  try {
    rmSync(targetProgram, { recursive: true, force: true })
    if (existsSync(targetPrevious)) {
      renameSync(targetPrevious, targetProgram)
    }
    return true
  } catch (error) {
    warn(`程序回滚失败：${error instanceof Error ? error.message : String(error)}；上一版留在 ${targetPrevious}`)
    return false
  }
}

function copyRuntime(sourceRuntime, targetRuntime, quiet) {
  if (!existsSync(sourceRuntime)) return false
  const staging = `${targetRuntime}.installing-${process.pid}-${randomUUID().slice(0, 8)}`
  const backup = `${targetRuntime}.previous-${process.pid}-${randomUUID().slice(0, 8)}`
  rmSync(staging, { recursive: true, force: true })
  try {
    cpSync(sourceRuntime, staging, { recursive: true })
    const hadTarget = existsSync(targetRuntime)
    if (hadTarget) {
      try {
        renameSync(targetRuntime, backup)
      } catch {
        rmSync(staging, { recursive: true, force: true })
        say('[install] runtime 正在使用，保留旧版本；程序仍可启动。', quiet)
        return false
      }
    }
    try {
      renameSync(staging, targetRuntime)
    } catch (error) {
      if (hadTarget && existsSync(backup)) {
        try { renameSync(backup, targetRuntime) } catch { /* 保留 backup */ }
      }
      throw error
    }
    rmSync(backup, { recursive: true, force: true })
    return true
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(targetRuntime)) {
      say(`[install] runtime 更新失败，保留旧版本：${error instanceof Error ? error.message : String(error)}`, quiet)
      return false
    }
    throw error
  }
}

function install(options) {
  const portable = options.portable
  const installDir = resolve(options.dir ?? (portable ? sourceRoot : defaultInstallDir()))
  const sourceProgram = join(sourceRoot, 'In_Fate')
  const targetProgram = join(installDir, 'In_Fate')
  const targetPrevious = join(installDir, 'previous')
  const inPlace = samePath(sourceProgram, targetProgram)
  const currentInfo = readJson(join(installDir, 'install.json'))
  const updating = Boolean(currentInfo)
  const sourceVersion = readVersion(sourceRoot) ?? readVersion(sourceProgram) ?? '0.0.0'
  const previousVersion = currentInfo?.version ?? readVersion(targetProgram)
  const dataDir = resolve(
    options.dataDir
      ?? (typeof currentInfo?.dataDir === 'string' && currentInfo.dataDir ? currentInfo.dataDir : undefined)
      ?? readHomeFile(installDir)
      ?? join(installDir, 'data'),
  )
  const icon = join(targetProgram, 'desktop', 'if-w3.ico')

  validateSourcePackage(sourceProgram, options)
  validatePaths({
    installDir,
    dataDir,
    sourceProgram,
    inPlace,
    force: options.force,
    repairing: false,
  })

  say(`[install] In_First V${sourceVersion}`, options.quiet)
  say(`[install] 安装根：${installDir}`, options.quiet)
  say(`[install] 程序：${targetProgram}`, options.quiet)
  say(`[install] 数据：${dataDir}`, options.quiet)
  if (updating) {
    say(`[install] 已安装 ${previousVersion ?? '(未知版本)'}，按升级处理；数据与配置保留。`, options.quiet)
  }

  if (options.dryRun) {
    say('[install] dry-run：只检查，不写文件。', options.quiet)
    if (integrationEnabled(options)) {
      runWindowsAction('Preflight', integrationContext(options, installDir, sourceVersion, icon))
      say('[install] Windows 快捷方式/卸载登记预检通过。', options.quiet)
    }
    say('[install] dry-run 完成。', options.quiet)
    return
  }

  if (integrationEnabled(options)) {
    runWindowsAction('Preflight', integrationContext(options, installDir, sourceVersion, icon))
    say('[install] Windows 快捷方式/卸载登记预检通过。', options.quiet)
  }

  mkdirSync(installDir, { recursive: true })
  assertWritable(installDir)
  assertWritable(dataDir)
  logLine(installDir, `install start version=${sourceVersion} source=${sourceRoot} target=${installDir} data=${dataDir}`)

  let deployed = false
  try {
    if (!inPlace) {
      deployProgram(sourceProgram, targetProgram, targetPrevious, installDir, options.quiet)
      deployed = true
    }

    const sourceRuntime = join(sourceRoot, 'runtime')
    if (!inPlace) copyRuntime(sourceRuntime, join(installDir, 'runtime'), options.quiet)
    copyTools(sourceRoot, installDir)

    if (!existsSync(join(installDir, 'config', 'if.release.json')) && existsSync(join(sourceRoot, 'config', 'if.release.json'))) {
      mkdirSync(join(installDir, 'config'), { recursive: true })
      cpSync(join(sourceRoot, 'config', 'if.release.json'), join(installDir, 'config', 'if.release.json'))
    }
    for (const dir of ['logs', 'backups']) mkdirSync(join(installDir, dir), { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    const installedDesktop = existsSync(join(targetProgram, 'desktop', 'run.mjs'))
    writeLaunchers(installDir, dataDir, installedDesktop)

    let integration = { skipped: true, shortcuts: [], registry: null }
    if (integrationEnabled(options)) {
      integration = runWindowsAction(
        'Register',
        integrationContext(options, installDir, sourceVersion, join(targetProgram, 'desktop', 'if-w3.ico')),
      )
      say('[install] 快捷方式与卸载登记已写入并验证。', options.quiet)
    }

    const now = new Date().toISOString()
    const info = {
      app: 'In_Fate',
      version: sourceVersion,
      installedAt: currentInfo?.installedAt ?? now,
      updatedAt: now,
      previousVersion: updating ? previousVersion : undefined,
      root: installDir,
      program: 'In_Fate',
      dataDir,
      portable,
      installRoot: installDir,
      installer: {
        schema: INSTALLER_SCHEMA,
        shortcuts: options.shortcuts ? (integration.shortcuts ?? []) : [],
        registry: options.registry ? (integration.registry ?? null) : null,
        verifiedAt: integration.skipped ? null : now,
        desktopDir: options.desktopDir ? resolve(options.desktopDir) : null,
        startMenuDir: options.startMenuDir ? resolve(options.startMenuDir) : null,
        registryKey: options.registryKey ?? DEFAULT_REGISTRY_KEY,
      },
    }
    writeInstallInfo(installDir, info)
    logLine(installDir, `install ok version=${sourceVersion} shortcuts=${info.installer.shortcuts.length} registry=${Boolean(info.installer.registry)}`)

    say('', options.quiet)
    say('[install] 完成。', options.quiet)
    if (isWindows && options.shortcuts) {
      say('  打开方式：桌面 / 开始菜单的「In_Fate」快捷方式', options.quiet)
    }
    const launchName = existsSync(join(installDir, isWindows ? 'start-desktop.cmd' : 'start-desktop.sh'))
      ? (isWindows ? 'start-desktop.cmd' : 'start-desktop.sh')
      : (isWindows ? 'start-if.cmd' : 'start-if.sh')
    say(`  也可以运行：${join(installDir, launchName)}`, options.quiet)
    say(`  浏览器版：${join(installDir, isWindows ? 'start-if.cmd' : 'start-if.sh')}`, options.quiet)
    say(`  修复安装：${join(installDir, isWindows ? 'repair.cmd' : 'tools/install.mjs --repair')}`, options.quiet)
    say(`  卸载：${join(installDir, isWindows ? 'uninstall.cmd' : 'tools/install.mjs --uninstall')}`, options.quiet)
    say(`  数据：${dataDir}（更新时不会动）`, options.quiet)
    say(`  安装日志：${join(installDir, 'logs', 'install.log')}`, options.quiet)
    launchInstalled(installDir, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logLine(installDir, `install failed: ${message}`)
    if (deployed) {
      const restored = rollbackProgram(targetProgram, targetPrevious)
      if (restored && previousVersion) {
        try {
          runWindowsAction(
            'Register',
            integrationContext(options, installDir, previousVersion, join(targetProgram, 'desktop', 'if-w3.ico')),
          )
          logLine(installDir, `restored registration for previous version ${previousVersion}`)
        } catch (restoreError) {
          warn(`上一版快捷方式/卸载登记恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
        }
      } else if (integrationEnabled(options) && !updating) {
        try {
          runWindowsAction('Unregister', integrationContext(options, installDir, sourceVersion, icon))
        } catch {
          // 首次安装失败时尽量清掉部分登记，清理失败不掩盖原始错误。
        }
      }
    }
    throw error
  }
}

function repair(options) {
  const installDir = resolve(options.dir ?? sourceRoot)
  const program = join(installDir, 'In_Fate')
  if (!existsSync(join(program, 'bin', 'if.ts'))) {
    throw new Error(`找不到已安装程序：${join(program, 'bin', 'if.ts')}`)
  }
  const info = readJson(join(installDir, 'install.json')) ?? {}
  const version = readVersion(program) ?? (typeof info.version === 'string' ? info.version : '0.0.0')
  const dataDir = resolve(
    options.dataDir
      ?? (typeof info.dataDir === 'string' && info.dataDir ? info.dataDir : undefined)
      ?? readHomeFile(installDir)
      ?? join(installDir, 'data'),
  )
  validatePaths({
    installDir,
    dataDir,
    sourceProgram: program,
    inPlace: true,
    force: options.force,
    repairing: true,
  })

  say(`[install] 修复 In_First V${version}`, options.quiet)
  say(`[install] 安装根：${installDir}`, options.quiet)
  say(`[install] 数据：${dataDir}`, options.quiet)

  if (options.dryRun) {
    say('[install] dry-run：只检查，不写文件。', options.quiet)
    if (integrationEnabled(options)) {
      runWindowsAction('Preflight', integrationContext(options, installDir, version, join(program, 'desktop', 'if-w3.ico')))
      say('[install] Windows 快捷方式/卸载登记预检通过。', options.quiet)
    }
    say('[install] dry-run 完成。', options.quiet)
    return
  }

  assertWritable(installDir)
  assertWritable(dataDir)
  logLine(installDir, `repair start version=${version} target=${installDir} data=${dataDir}`)

  if (integrationEnabled(options)) {
    runWindowsAction('Preflight', integrationContext(options, installDir, version, join(program, 'desktop', 'if-w3.ico')))
  }

  copyTools(sourceRoot, installDir)
  for (const dir of ['logs', 'backups']) mkdirSync(join(installDir, dir), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeLaunchers(installDir, dataDir, existsSync(join(program, 'desktop', 'run.mjs')))

  let integration = { skipped: true, shortcuts: [], registry: null }
  if (integrationEnabled(options)) {
    try {
      integration = runWindowsAction(
        'Register',
        integrationContext(options, installDir, version, join(program, 'desktop', 'if-w3.ico')),
      )
    } catch (error) {
      logLine(installDir, `repair failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    say('[install] 快捷方式与卸载登记已重建并验证。', options.quiet)
  }

  const now = new Date().toISOString()
  const nextInfo = {
    ...info,
    app: 'In_Fate',
    version,
    installedAt: info.installedAt ?? now,
    updatedAt: now,
    root: installDir,
    program: 'In_Fate',
    dataDir,
    portable: info.portable ?? false,
    installRoot: installDir,
    repairedAt: now,
    installer: {
      schema: INSTALLER_SCHEMA,
      shortcuts: options.shortcuts ? (integration.shortcuts ?? []) : [],
      registry: options.registry ? (integration.registry ?? null) : null,
      verifiedAt: integration.skipped ? null : now,
      desktopDir: options.desktopDir ? resolve(options.desktopDir) : null,
      startMenuDir: options.startMenuDir ? resolve(options.startMenuDir) : null,
      registryKey: options.registryKey ?? DEFAULT_REGISTRY_KEY,
    },
  }
  writeInstallInfo(installDir, nextInfo)
  logLine(installDir, `repair ok version=${version} shortcuts=${nextInfo.installer.shortcuts.length} registry=${Boolean(nextInfo.installer.registry)}`)
  say('', options.quiet)
  say('[install] 修复完成。', options.quiet)
  say(`  安装日志：${join(installDir, 'logs', 'install.log')}`, options.quiet)
  if (options.launchExplicit) launchInstalled(installDir, options)
}

function scheduleCleanup(paths, quiet) {
  if (!isWindows || paths.length === 0) return false
  const scriptPath = join(tmpdir(), `if-uninstall-${process.pid}-${randomUUID()}.ps1`)
  const quoted = paths.map(path => `'${path.replaceAll("'", "''")}'`).join(', ')
  writeText(scriptPath, `$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds 2
$targets = @(${quoted})
foreach ($target in $targets) {
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Test-Path -LiteralPath $target)) { break }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`)
  try {
    spawn(powershellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], {
      cwd: tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    say(`[uninstall] 已安排延迟清理：${paths.join('；')}`, quiet)
    return true
  } catch (error) {
    say(`[uninstall] 延迟清理启动失败：${error instanceof Error ? error.message : String(error)}`, quiet)
    return false
  }
}

function uninstall(options) {
  const installDir = resolve(options.dir ?? sourceRoot)
  const installJson = readJson(join(installDir, 'install.json')) ?? {}
  let dataDir = installJson?.dataDir
  if (typeof dataDir !== 'string' || dataDir === '') dataDir = readHomeFile(installDir)
  if ((typeof dataDir !== 'string' || dataDir === '') && existsSync(join(installDir, 'data'))) {
    dataDir = join(installDir, 'data')
  }
  const data = typeof dataDir === 'string' && dataDir !== '' ? resolve(dataDir) : undefined

  say(`[uninstall] 程序目录：${installDir}`, options.quiet)
  if (data) say(`[uninstall] 数据目录：${data}`, options.quiet)
  if (existsSync(installDir)) {
    logLine(installDir, `uninstall start target=${installDir} data=${data ?? '(unknown)'} purge=${options.purge} force=${options.force}`)
  }

  const installMeta = installJson?.installer
  const hasInstallMeta = installMeta !== null && typeof installMeta === 'object'
  const removeShortcuts = options.shortcuts && (hasInstallMeta
    ? Array.isArray(installMeta.shortcuts) && installMeta.shortcuts.length > 0
    : true)
  const removeRegistry = options.registry && (hasInstallMeta
    ? Boolean(installMeta.registry)
    : true)

  if (isWindows && (removeShortcuts || removeRegistry)) {
    try {
      const removed = runWindowsAction('Unregister', integrationContext(
        { ...options, shortcuts: removeShortcuts, registry: removeRegistry },
        installDir,
        typeof installJson.version === 'string' ? installJson.version : '0.0.0',
        join(installDir, 'In_Fate', 'desktop', 'if-w3.ico'),
      ))
      if (removed?.removedShortcuts?.length || removed?.registry) {
        say('[uninstall] 已移除快捷方式/卸载登记。', options.quiet)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!options.force) {
        throw new Error(`无法移除快捷方式/卸载登记：${message}；程序未删除。确认后可用 --force 继续。`)
      }
      warn(`快捷方式/卸载登记清理失败，按 --force 继续：${message}`)
    }
  }

  if (!options.purge && data) {
    if (existsSync(join(installDir, 'config'))) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupRoot = samePath(data, installDir) ? join(data, 'data') : data
      const backup = join(backupRoot, `config-uninstalled-${stamp}`)
      try {
        mkdirSync(backup, { recursive: true })
        cpSync(join(installDir, 'config'), backup, { recursive: true })
        say(`[uninstall] 配置已备份到 ${backup}`, options.quiet)
      } catch (error) {
        say(`[uninstall] 配置备份失败：${error instanceof Error ? error.message : String(error)}`, options.quiet)
      }
    }
  }

  const dataIsRoot = data !== undefined && samePath(data, installDir)
  const dataInsideInstall = data !== undefined && inside(installDir, data)
  const deferred = []

  if (!options.purge && dataInsideInstall) {
    let entries = []
    try {
      entries = readdirSync(installDir)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const full = join(installDir, entry)
      if (dataIsRoot) {
        if (entry === 'data') continue
      } else if (samePath(full, data) || inside(full, data)) {
        continue
      }
      if (!removePath(full, options.quiet)) deferred.push(full)
    }
    say(`[uninstall] 已保留安装目录内的数据：${data}`, options.quiet)
  } else {
    if (options.purge && data && !dataInsideInstall) {
      if (!removePath(data, options.quiet)) deferred.push(data)
    }
    if (!removePath(installDir, options.quiet)) deferred.push(installDir)
  }

  if (deferred.length > 0) scheduleCleanup(deferred, options.quiet)
  say('[uninstall] 完成。', options.quiet)
}

function launchInstalled(installDir, options) {
  if (!options.launch) return
  try {
    if (isWindows) {
      const wscript = wscriptPath()
      const desktopVbs = join(installDir, 'start-desktop.vbs')
      const ifVbs = join(installDir, 'start-if.vbs')
      const launcher = existsSync(desktopVbs) ? desktopVbs : existsSync(ifVbs) ? ifVbs : undefined
      if (launcher) {
        spawn(wscript, [launcher], {
          cwd: installDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      } else {
        spawn(cmdPath(), ['/c', 'start', '', 'start-desktop.cmd'], {
          cwd: installDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      }
      say('[install] 已启动 In_Fate。', options.quiet)
      return
    }
    const shell = join(installDir, 'start-desktop.sh')
    if (existsSync(shell)) {
      spawn(shell, [], { cwd: installDir, detached: true, stdio: 'ignore' }).unref()
      say('[install] 已启动 In_Fate。', options.quiet)
    }
  } catch (error) {
    say(`[install] 自动启动失败：${error instanceof Error ? error.message : String(error)}`, options.quiet)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`In_Fate 安装器

  node tools/install.mjs [选项]

  --dir <目录>        安装根（默认 ${defaultInstallDir()}）
  --data-dir <目录>   数据目录（默认 <安装根>/data）
  --portable          就地注册当前发布包，不复制到默认安装根
  --repair            修复安装：重建启动脚本、快捷方式、卸载登记，不复制程序
  --dry-run           只做检查，不写文件
  --force             目标目录非空且不像 In_First 安装根时仍然写入；卸载时强行继续
  --launch            安装完成后启动 In_Fate（终端里默认开启）
  --no-launch         安装完成后不启动
  --no-shortcuts      不创建桌面/开始菜单快捷方式
  --no-registry       不写卸载注册表
  --desktop-dir <目录>      覆盖桌面快捷方式目录（测试/高级）
  --start-menu-dir <目录>   覆盖开始菜单目录（测试/高级）
  --registry-key <键>       覆盖卸载登记键（测试/高级）
  --uninstall         卸载
  --purge             卸载时连数据一起删除
  --quiet             少打印
`)
    return
  }
  if (options.uninstall) uninstall(options)
  else if (options.repair) repair(options)
  else install(options)
}

try {
  main()
} catch (error) {
  console.error(`[install] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
