/**
 * In_Fate 内置安装器 / 卸载器。
 *
 * 从发布包根目录运行：
 *   node tools/install.mjs [--dir <安装目录>] [--data-dir <数据目录>]
 *                          [--portable] [--no-shortcuts] [--no-registry]
 *                          [--uninstall] [--purge] [--quiet]
 *
 * 布局：<安装根>/In_Fate 是程序，<安装根>/data 是数据。
 * 安装版默认根：%USERPROFILE%\In_First。
 * 便携版（--portable）：根就是当前发布包目录，就地注册。
 *
 * 安装器只做首次部署和手动升级；日常更新走程序内置更新器，
 * 它下载到 app/.updates，由启动脚本应用。
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '..')
const isWindows = process.platform === 'win32'

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
    launch: process.stdout.isTTY === true,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dir') options.dir = argv[++index]
    else if (arg === '--data-dir') options.dataDir = argv[++index]
    else if (arg === '--portable') options.portable = true
    else if (arg === '--no-shortcuts') options.shortcuts = false
    else if (arg === '--no-registry') options.registry = false
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--purge') options.purge = true
    else if (arg === '--force') options.force = true
    else if (arg === '--launch') options.launch = true
    else if (arg === '--no-launch') options.launch = false
    else if (arg === '--quiet') options.quiet = true
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readVersion(dir) {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function copyDir(from, to) {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  // Windows 批处理/脚本用 CRLF，避免 CMD/WSH 的换行解析问题。
  const content = /\.(cmd|vbs)$/i.test(path) ? text.replace(/\r?\n/g, '\r\n') : text
  writeFileSync(path, content, 'utf8')
}

function startIfCmd() {
  return `@echo off
setlocal
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
"%NODE%" "%~dp0In_Fate\\bin\\if.ts" serve -c "%~dp0config\\if.release.json" --port 8787 --ui-dir "%~dp0In_Fate\\ui\\dist"
if errorlevel 1 pause
`
}

function startDesktopCmd() {
  return `@echo off
setlocal
cd /d "%~dp0"
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

function uninstallCmd() {
  return `@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0tools\\install.mjs" --uninstall --quiet
pause
`
}

function startDesktopVbs() {
  return `Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run Chr(34) & base & "\\start-desktop.cmd" & Chr(34), 0, False
`
}

function powershell(script) {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const exe = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return spawnSync(existsSync(exe) ? exe : 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], { encoding: 'utf8', windowsHide: true })
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function createShortcuts(installDir, quiet) {
  if (!isWindows) return
  const icon = join(installDir, 'In_Fate', 'desktop', 'if-w3.ico')
  const target = join(installDir, 'start-desktop.vbs')
  const script = `
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
foreach ($dir in @($desktop, $programs)) {
  if (-not (Test-Path $dir)) { continue }
  $path = Join-Path $dir 'In_Fate.lnk'
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = ${quotePowerShell(target)}
  $link.WorkingDirectory = ${quotePowerShell(installDir)}
  $link.IconLocation = ${quotePowerShell(existsSync(icon) ? icon : target)}
  $link.Description = 'In_Fate'
  $link.Save()
}
`
  const result = powershell(script)
  if (result.status !== 0) {
    say(`[install] 快捷方式创建失败：${(result.stderr ?? '').trim() || 'unknown error'}`, quiet)
  }
}

function removeShortcuts() {
  if (!isWindows) return
  const script = `
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
foreach ($dir in @($desktop, $programs)) {
  $path = Join-Path $dir 'In_Fate.lnk'
  if (Test-Path $path) { Remove-Item -LiteralPath $path -Force }
}
`
  powershell(script)
}

function registryKey() {
  return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\In_Fate'
}

function registerInstall(installDir, version) {
  if (!isWindows) return
  const key = registryKey()
  const ifIcon = join(installDir, 'In_Fate', 'desktop', 'if-w3.ico')
  const electronIcon = join(installDir, 'In_Fate', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
  const displayIcon = existsSync(ifIcon)
    ? ifIcon
    : existsSync(electronIcon)
      ? electronIcon
      : join(installDir, 'uninstall.cmd')
  const values = [
    ['DisplayName', 'In_Fate'],
    ['DisplayVersion', version],
    ['InstallLocation', installDir],
    ['UninstallString', `"${join(installDir, 'uninstall.cmd')}"`],
    ['DisplayIcon', displayIcon],
    ['Publisher', 'In_Fate'],
    ['NoModify', '1'],
    ['NoRepair', '1'],
  ]
  for (const [name, value] of values) {
    spawnSync('reg.exe', ['add', key, '/f', '/v', name, '/t', 'REG_SZ', '/d', value], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
}

function unregisterInstall() {
  if (!isWindows) return
  spawnSync('reg.exe', ['delete', registryKey(), '/f'], { stdio: 'ignore', windowsHide: true })
}

function launchInstalled(installDir, options) {
  if (!options.launch) return
  if (isWindows) {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const wscript = join(systemRoot, 'System32', 'wscript.exe')
    const vbs = join(installDir, 'start-desktop.vbs')
    try {
      if (existsSync(vbs)) {
        spawn(wscript, [vbs], {
          cwd: installDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      } else {
        spawn('cmd.exe', ['/c', 'start', '', 'start-desktop.cmd'], {
          cwd: installDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      }
      say('[install] 已启动 In_Fate。', options.quiet)
    } catch (error) {
      say(`[install] 自动启动失败：${error instanceof Error ? error.message : String(error)}`, options.quiet)
    }
    return
  }
  const shell = join(installDir, 'start-desktop.sh')
  if (!existsSync(shell)) return
  try {
    spawn(shell, [], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
    }).unref()
    say('[install] 已启动 In_Fate。', options.quiet)
  } catch {
    // 非 Windows 桌面自启失败不影响安装
  }
}

function install(options) {
  const portable = options.portable
  const installDir = resolve(options.dir ?? (portable ? sourceRoot : defaultInstallDir()))
  const dataDir = options.dataDir ? resolve(options.dataDir) : join(installDir, 'data')
  const sourceProgram = join(sourceRoot, 'In_Fate')
  const sourceRuntime = join(sourceRoot, 'runtime')
  const sourceConfig = join(sourceRoot, 'config', 'if.release.json')
  const sourceVersion = readVersion(sourceRoot) ?? readVersion(sourceProgram) ?? '0.0.0'
  const inPlace = resolve(sourceProgram) === resolve(join(installDir, 'In_Fate'))

  if (!existsSync(join(sourceProgram, 'bin', 'if.ts'))) {
    throw new Error(`这个目录不是完整发布包：找不到 ${join(sourceProgram, 'bin', 'if.ts')}`)
  }

  if (!inPlace && existsSync(installDir)) {
    let entries = []
    try {
      entries = readdirSync(installDir)
    } catch {
      entries = []
    }
    const looksLikeIfRoot = existsSync(join(installDir, 'install.json'))
      || existsSync(join(installDir, 'In_Fate'))
      || existsSync(join(installDir, 'data'))
      || existsSync(join(installDir, 'config', 'if.release.json'))
    if (entries.length > 0 && !looksLikeIfRoot && !options.force) {
      throw new Error(`目标目录不是 In_First 安装根：${installDir}；换 --dir 或加 --force`)
    }
  }

  say(`[install] In_First V${sourceVersion}`, options.quiet)
  say(`[install] 安装根：${installDir}`, options.quiet)
  say(`[install] 程序：${join(installDir, 'In_Fate')}`, options.quiet)
  say(`[install] 数据：${dataDir}`, options.quiet)

  mkdirSync(installDir, { recursive: true })
  const targetProgram = join(installDir, 'In_Fate')
  const targetPrevious = join(installDir, 'previous')

  const updating = existsSync(join(installDir, 'install.json'))
  if (updating) {
    const old = readJson(join(installDir, 'install.json'))
    say(`[install] 已安装 ${old?.version ?? '(未知版本)'}，按升级处理；数据与配置保留。`, options.quiet)
  }
  if (!inPlace) {
    if (existsSync(targetProgram)) {
      rmSync(targetPrevious, { recursive: true, force: true })
      try {
        // 同卷 rename 比整目录复制快得多；失败再退回复制。
        renameSync(targetProgram, targetPrevious)
      } catch {
        try {
          cpSync(targetProgram, targetPrevious, { recursive: true })
        } catch (error) {
          say(`[install] 旧版本备份失败，继续安装：${error instanceof Error ? error.message : String(error)}`, options.quiet)
        }
      }
      rmSync(targetProgram, { recursive: true, force: true })
    }
    copyDir(sourceProgram, targetProgram)

    if (existsSync(sourceRuntime)) {
      try {
        copyDir(sourceRuntime, join(installDir, 'runtime'))
      } catch (error) {
        say(`[install] runtime 复制失败；将回退系统 node：${error instanceof Error ? error.message : String(error)}`, options.quiet)
      }
    }

    mkdirSync(join(installDir, 'tools'), { recursive: true })
    cpSync(join(sourceRoot, 'tools', 'apply-pending.mjs'), join(installDir, 'tools', 'apply-pending.mjs'))
    cpSync(join(sourceRoot, 'tools', 'install.mjs'), join(installDir, 'tools', 'install.mjs'))
  }

  if (!existsSync(join(installDir, 'config', 'if.release.json')) && existsSync(sourceConfig)) {
    mkdirSync(join(installDir, 'config'), { recursive: true })
    cpSync(sourceConfig, join(installDir, 'config', 'if.release.json'))
  }
  for (const dir of ['logs', 'backups']) {
    mkdirSync(join(installDir, dir), { recursive: true })
  }
  mkdirSync(dataDir, { recursive: true })

  write(join(installDir, 'if-home.txt'), `${dataDir}\n`)
  write(join(installDir, 'start-if.cmd'), startIfCmd())
  write(join(installDir, 'start-desktop.cmd'), startDesktopCmd())
  write(join(installDir, 'start-if.sh'), startIfSh())
  write(join(installDir, 'start-desktop.sh'), startDesktopSh())
  write(join(installDir, 'uninstall.cmd'), uninstallCmd())
  if (isWindows) write(join(installDir, 'start-desktop.vbs'), startDesktopVbs())
  if (!isWindows) {
    for (const name of ['start-if.sh', 'start-desktop.sh']) {
      chmodSync(join(installDir, name), 0o755)
    }
  }

  write(join(installDir, 'install.json'), `${JSON.stringify({
    app: 'In_Fate',
    version: sourceVersion,
    installedAt: new Date().toISOString(),
    root: installDir,
    program: 'In_Fate',
    dataDir,
    portable,
    installRoot: installDir,
  }, null, 2)}\n`)

  if (options.shortcuts) createShortcuts(installDir, options.quiet)
  if (options.registry) registerInstall(installDir, sourceVersion)

  say('', options.quiet)
  say('[install] 完成。', options.quiet)
  if (options.shortcuts) {
    say('  打开方式：桌面 / 开始菜单的「In_Fate」快捷方式', options.quiet)
  }
  say(`  也可以运行：${join(installDir, isWindows ? 'start-desktop.cmd' : 'start-desktop.sh')}`, options.quiet)
  say(`  浏览器版：${join(installDir, isWindows ? 'start-if.cmd' : 'start-if.sh')}`, options.quiet)
  say(`  卸载：${join(installDir, isWindows ? 'uninstall.cmd' : 'tools/install.mjs --uninstall')}`, options.quiet)
  say(`  数据：${dataDir}（更新时不会动）`, options.quiet)
  launchInstalled(installDir, options)
}

function inside(base, target) {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

function removeQuietly(path, quiet) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    say(
      `[uninstall] 稍后手动删除 ${path}：${error instanceof Error ? error.message : String(error)}`,
      quiet,
    )
  }
}

function uninstall(options) {
  const installDir = resolve(options.dir ?? sourceRoot)
  const installJson = readJson(join(installDir, 'install.json'))
  const homeFile = join(installDir, 'if-home.txt')
  let dataDir = installJson?.dataDir
  if (typeof dataDir !== 'string' || dataDir === '') {
    try {
      dataDir = readFileSync(homeFile, 'utf8').split(/\r?\n/)[0].trim()
    } catch {
      dataDir = undefined
    }
  }
  // 元数据丢失时按布局回退，避免把 <安装根>/data 一起删掉。
  if ((typeof dataDir !== 'string' || dataDir === '')
    && existsSync(join(installDir, 'data'))) {
    dataDir = join(installDir, 'data')
  }
  const data = typeof dataDir === 'string' && dataDir !== '' ? resolve(dataDir) : undefined
  say(`[uninstall] 程序目录：${installDir}`, options.quiet)
  if (data) say(`[uninstall] 数据目录：${data}`, options.quiet)

  removeShortcuts()
  unregisterInstall()

  if (options.purge && data) {
    say(`[uninstall] 删除数据：${data}`, options.quiet)
    removeQuietly(data, options.quiet)
  } else if (data) {
    say(`[uninstall] 保留数据：${data}`, options.quiet)
    // 卸载时把配置留一份到数据目录，避免重装后丢 provider 和 key。
    if (existsSync(join(installDir, 'config'))) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      // 旧版便携安装把 dataDir 设为安装根本身，数据在 <根>/data。
      const backupRoot = data === installDir ? join(data, 'data') : data
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

  const dataIsRoot = data !== undefined && data === installDir
  const dataInsideInstall = data !== undefined && inside(installDir, data)

  if (!options.purge && dataInsideInstall) {
    // 数据在安装目录里（便携版）：逐项删除，但保留数据路径。
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
      } else if (full === data || data.startsWith(`${full}${sep}`)) {
        continue
      }
      removeQuietly(full, options.quiet)
    }
    say(`[uninstall] 已保留安装目录内的数据：${data}`, options.quiet)
  } else {
    const runtimeInUse = inside(installDir, resolve(process.execPath))
    if (runtimeInUse) {
      say('[uninstall] runtime 正在被当前进程使用，已安排延迟清理；如仍残留可手动删除。', options.quiet)
      const script = `@echo off
timeout /t 2 /nobreak >nul
rmdir /s /q "${installDir}"
`
      const cleanup = join(installDir, 'cleanup.cmd')
      try {
        write(cleanup, script)
        spawnSync('cmd.exe', ['/c', 'start', '', '/min', cleanup], { stdio: 'ignore', windowsHide: true })
      } catch {
        // 清理失败不影响主流程
      }
    } else {
      removeQuietly(installDir, options.quiet)
    }
  }
  say('[uninstall] 完成。', options.quiet)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`In_Fate 安装器

  node tools/install.mjs [选项]

  --dir <目录>        安装根（默认 ${defaultInstallDir()}）
  --data-dir <目录>   数据目录（默认 <安装根>/data）
  --portable          就地注册当前发布包，不复制到默认安装根
  --force             目标目录非空且不像 In_First 安装根时仍然写入
  --launch            安装完成后启动 In_Fate（终端里默认开启）
  --no-launch         安装完成后不启动
  --no-shortcuts      不创建桌面/开始菜单快捷方式
  --no-registry       不写卸载注册表
  --uninstall         卸载
  --purge             卸载时连数据一起删除
  --quiet             少打印
`)
    return
  }
  if (options.uninstall) uninstall(options)
  else install(options)
}

try {
  main()
} catch (error) {
  console.error(`[install] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
