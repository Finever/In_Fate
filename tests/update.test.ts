import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  compareVersions,
  fetchUpdateManifest,
  parseUpdateManifest,
  resolveUpdateLayout,
  UpdateService,
} from '../src/app/update.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const applyScript = join(repoRoot, 'tools', 'apply-pending.mjs')
const installScript = join(repoRoot, 'tools', 'install.mjs')
const windowsIntegrationScript = join(repoRoot, 'tools', 'windows-install.ps1')
const isWindows = process.platform === 'win32'
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const regExe = join(systemRoot, 'System32', 'reg.exe')
const powershellExe = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const cscExe = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canBuildSetupExe = isWindows && existsSync(cscExe) && existsSync(powershellExe)

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function writeCrlf(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text.replace(/\r?\n/g, '\r\n'), 'utf8')
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

function makePackage(root: string, version = '0.0.1'): string {
  const pkg = join(root, 'pkg')
  write(join(pkg, 'VERSION'), `${version}\n`)
  write(join(pkg, 'In_Fate', 'VERSION'), `${version}\n`)
  write(join(pkg, 'In_Fate', 'bin', 'if.ts'), '// if\n')
  write(join(pkg, 'In_Fate', 'desktop', 'run.mjs'), '// desktop\n')
  write(join(pkg, 'In_Fate', 'desktop', 'if-w3.ico'), 'icon\n')
  write(join(pkg, 'config', 'if.release.json'), '{}\n')
  write(join(pkg, 'tools', 'install.mjs'), readFileSync(installScript, 'utf8'))
  write(join(pkg, 'tools', 'apply-pending.mjs'), readFileSync(applyScript, 'utf8'))
  write(join(pkg, 'tools', 'windows-install.ps1'), readFileSync(windowsIntegrationScript, 'utf8'))
  writeCrlf(join(pkg, 'install.cmd'), `@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0tools\\install.mjs" %*
exit /b %errorlevel%
`)
  return pkg
}

function uniqueRegistryKey(): string {
  return `HKCU\\Software\\InFateInstallerTests\\${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}\\In_Fate`
}

function deleteRegistryKey(key: string): void {
  if (!isWindows) return
  spawnSync(regExe, ['delete', key, '/f'], { stdio: 'ignore' })
}

function readShortcut(path: string, root: string): { target: string; arguments: string } {
  const script = join(root, 'read-shortcut.ps1')
  write(script, `param([string]$Path)
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($Path)
Write-Output $link.TargetPath
Write-Output $link.Arguments
`)
  const result = spawnSync(powershellExe, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    path,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split(/\r?\n/)
  return { target: lines[0] ?? '', arguments: lines[1] ?? '' }
}

test('版本比较按语义化版本，预发布版小于正式版', () => {
  assert.equal(compareVersions('0.0.1', '0.0.2') < 0, true)
  assert.equal(compareVersions('0.10.0', '0.9.9') > 0, true)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0') < 0, true)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0, true)
  assert.equal(compareVersions('0.0.1', '0.0.1.1') < 0, true)
  assert.equal(compareVersions('0.0.1.1', '0.0.1.2') < 0, true)
  assert.equal(compareVersions('0.0.1.1', '0.0.2') < 0, true)
  assert.throws(() => compareVersions('1.0', '1.0.0'))
})

test('更新清单校验版本、地址和 sha256', () => {
  const sha = 'a'.repeat(64)
  const manifest = parseUpdateManifest({
    version: '0.0.2',
    url: 'if-v0.0.2-win32-x64.zip',
    sha256: sha.toUpperCase(),
    size: 1024,
    notes: 'test',
  })
  assert.equal(manifest.sha256, sha)
  assert.equal(manifest.size, 1024)
  assert.throws(() => parseUpdateManifest({ version: '0.0.2', url: 'x', sha256: 'bad' }))
  assert.throws(() => parseUpdateManifest({ version: '1.0', url: 'x', sha256: sha }))
  assert.throws(() => parseUpdateManifest(null))
})

test('安装布局识别 dev / portable / installed', () => {
  const root = tempDir('if-update-layout-')
  try {
    const dev = resolveUpdateLayout({
      programRoot: root,
      dataRoot: join(root, 'data'),
      currentVersion: '0.0.1',
    })
    assert.equal(dev.layout, 'dev')

    const installRoot = join(root, 'In_First')
    const current = join(installRoot, 'In_Fate')
    mkdirSync(current, { recursive: true })
    mkdirSync(join(installRoot, 'data'), { recursive: true })
    write(join(installRoot, 'config', 'if.release.json'), '{}\n')
    const portable = resolveUpdateLayout({
      programRoot: current,
      dataRoot: join(installRoot, 'data'),
      currentVersion: '0.0.1',
    })
    assert.equal(portable.layout, 'portable')
    assert.equal(portable.installRoot, installRoot)

    write(join(installRoot, 'install.json'), '{}')
    const installed = resolveUpdateLayout({
      programRoot: current,
      dataRoot: join(installRoot, 'data'),
      currentVersion: '0.0.1',
    })
    assert.equal(installed.layout, 'installed')
    assert.equal(installed.appDir, current)
  } finally {
    cleanup(root)
  }
})

test('本地更新清单支持相对包地址', async () => {
  const root = tempDir('if-update-manifest-')
  try {
    const manifestPath = join(root, 'latest.json')
    write(manifestPath, JSON.stringify({
      version: '0.0.2',
      url: 'if-v0.0.2-win32-x64.zip',
      sha256: 'b'.repeat(64),
      size: 10,
    }))
    const result = await fetchUpdateManifest(manifestPath, '0.0.1')
    assert.equal(result.available, true)
    assert.equal(
      result.resolvedUrl,
      pathToFileURL(join(root, 'if-v0.0.2-win32-x64.zip')).href,
    )
    const same = await fetchUpdateManifest(manifestPath, '0.0.2')
    assert.equal(same.available, false)
  } finally {
    cleanup(root)
  }
})

test('apply-pending 切换 In_Fate 并保留 previous', () => {
  const root = tempDir('if-update-apply-')
  try {
    write(join(root, 'In_Fate', 'VERSION'), '0.0.1\n')
    write(join(root, 'In_Fate', 'bin', 'if.ts'), '// old\n')
    write(join(root, '.updates', '0.0.2', 'program', 'VERSION'), '0.0.2\n')
    write(join(root, '.updates', '0.0.2', 'program', 'bin', 'if.ts'), '// new\n')
    write(join(root, '.updates', 'pending.json'), JSON.stringify({
      action: 'apply',
      version: '0.0.2',
      fromVersion: '0.0.1',
      program: '.updates/0.0.2/program',
      requestedAt: '2026-11-18T00:00:00.000Z',
    }))

    const result = spawnSync(process.execPath, [applyScript, root], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(root, 'In_Fate', 'VERSION'), 'utf8').trim(), '0.0.2')
    assert.equal(readFileSync(join(root, 'previous', 'VERSION'), 'utf8').trim(), '0.0.1')
    assert.equal(existsSync(join(root, '.updates', 'pending.json')), false)
  } finally {
    cleanup(root)
  }
})

test('apply-pending 拒绝安装根下的伪暂存目录，不误删数据', () => {
  const root = tempDir('if-update-pending-traversal-')
  try {
    write(join(root, 'In_Fate', 'VERSION'), '0.0.1\n')
    write(join(root, 'In_Fate', 'bin', 'if.ts'), '// old\n')
    write(join(root, 'data', 'keep.txt'), 'important\n')
    write(join(root, 'evil', 'VERSION'), '0.0.2\n')
    write(join(root, 'evil', 'bin', 'if.ts'), '// evil\n')
    write(join(root, '.updates', 'pending.json'), JSON.stringify({
      action: 'apply',
      version: '0.0.2',
      fromVersion: '0.0.1',
      program: 'evil',
      requestedAt: '2026-11-18T00:00:00.000Z',
    }))

    const result = spawnSync(process.execPath, [applyScript, root], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /越界|暂存子目录|目录名不合法/)
    assert.equal(readFileSync(join(root, 'In_Fate', 'VERSION'), 'utf8').trim(), '0.0.1')
    assert.equal(readFileSync(join(root, 'data', 'keep.txt'), 'utf8'), 'important\n')
  } finally {
    cleanup(root)
  }
})

test('重启后恢复已下载的暂存更新', () => {
  const root = tempDir('if-update-restore-')
  try {
    const installRoot = join(root, 'In_First')
    const current = join(installRoot, 'In_Fate')
    write(join(current, 'VERSION'), '0.0.1\n')
    write(join(current, 'bin', 'if.ts'), '// old\n')
    write(join(installRoot, 'config', 'if.release.json'), '{}\n')
    mkdirSync(join(installRoot, 'data'), { recursive: true })
    write(join(installRoot, '.updates', '0.0.2', 'program', 'VERSION'), '0.0.2\n')
    write(join(installRoot, '.updates', '0.0.2', 'program', 'bin', 'if.ts'), '// new\n')

    const layout = resolveUpdateLayout({
      programRoot: current,
      dataRoot: join(installRoot, 'data'),
      currentVersion: '0.0.1',
    })
    const service = new UpdateService({ layout })
    try {
      assert.equal(service.job().state, 'ready')
      assert.equal(service.job().version, '0.0.2')
    } finally {
      service.dispose()
    }
  } finally {
    cleanup(root)
  }
})

test('apply-pending 拒绝与来源版本不一致的 pending', () => {
  const root = tempDir('if-update-mismatch-')
  try {
    write(join(root, 'In_Fate', 'VERSION'), '0.0.3\n')
    write(join(root, 'In_Fate', 'bin', 'if.ts'), '// current\n')
    write(join(root, '.updates', '0.0.2', 'program', 'VERSION'), '0.0.2\n')
    write(join(root, '.updates', '0.0.2', 'program', 'bin', 'if.ts'), '// staged\n')
    write(join(root, '.updates', 'pending.json'), JSON.stringify({
      action: 'apply',
      version: '0.0.2',
      fromVersion: '0.0.1',
      program: '.updates/0.0.2/program',
      requestedAt: '2026-11-18T00:00:00.000Z',
    }))

    const result = spawnSync(process.execPath, [applyScript, root], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(join(root, 'In_Fate', 'VERSION'), 'utf8').trim(), '0.0.3')
    assert.equal(existsSync(join(root, '.updates', 'pending.json')), true)
  } finally {
    cleanup(root)
  }
})

test('apply-pending 回滚到 previous', () => {
  const root = tempDir('if-update-rollback-')
  try {
    write(join(root, 'In_Fate', 'VERSION'), '0.0.2\n')
    write(join(root, 'In_Fate', 'bin', 'if.ts'), '// new\n')
    write(join(root, 'previous', 'VERSION'), '0.0.1\n')
    write(join(root, 'previous', 'bin', 'if.ts'), '// old\n')
    write(join(root, '.updates', 'pending.json'), JSON.stringify({
      action: 'rollback',
      version: '0.0.1',
      fromVersion: '0.0.2',
      requestedAt: '2026-11-18T00:00:00.000Z',
    }))

    const result = spawnSync(process.execPath, [applyScript, root], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(root, 'In_Fate', 'VERSION'), 'utf8').trim(), '0.0.1')
    assert.equal(existsSync(join(root, 'previous')), false)
    assert.equal(existsSync(join(root, '.updates', 'pending.json')), false)
  } finally {
    cleanup(root)
  }
})

test('安装器部署程序层并把数据放到外部目录', () => {
  const root = tempDir('if-install-')
  try {
    const pkg = join(root, 'pkg')
    write(join(pkg, 'VERSION'), '0.0.1\n')
    write(join(pkg, 'In_Fate', 'VERSION'), '0.0.1\n')
    write(join(pkg, 'In_Fate', 'bin', 'if.ts'), '// if\n')
    write(join(pkg, 'In_Fate', 'desktop', 'run.mjs'), '// desktop\n')
    write(join(pkg, 'config', 'if.release.json'), '{}\n')
    write(join(pkg, 'tools', 'install.mjs'), readFileSync(installScript, 'utf8'))
    write(join(pkg, 'tools', 'apply-pending.mjs'), readFileSync(applyScript, 'utf8'))

    const installDir = join(root, 'installed')
    const dataDir = join(root, 'IN_FIRST')
    const result = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', installDir,
      '--data-dir', dataDir,
      '--no-shortcuts',
      '--no-registry',
      '--quiet',
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(installDir, 'In_Fate', 'bin', 'if.ts')), true)
    assert.equal(readFileSync(join(installDir, 'if-home.txt'), 'utf8').trim(), dataDir)
    assert.equal(existsSync(join(installDir, 'start-if.cmd')), true)
    assert.equal(existsSync(join(installDir, 'start-desktop.cmd')), true)
    assert.equal(existsSync(join(installDir, 'tools', 'apply-pending.mjs')), true)
    const info = JSON.parse(readFileSync(join(installDir, 'install.json'), 'utf8'))
    assert.equal(info.version, '0.0.1')
    assert.equal(info.dataDir, dataDir)
    assert.equal(info.portable, false)

    const uninstall = spawnSync(process.execPath, [
      join(installDir, 'tools', 'install.mjs'),
      '--uninstall',
      '--quiet',
      '--dir', installDir,
    ], { encoding: 'utf8' })
    assert.equal(uninstall.status, 0, uninstall.stderr)
    assert.equal(existsSync(installDir), false)
    assert.equal(existsSync(dataDir), true)
    // 配置在卸载时留了一份到数据目录。
    const backups = readdirSync(dataDir).filter(name => name.startsWith('config-uninstalled-'))
    assert.equal(backups.length, 1)
  } finally {
    cleanup(root)
  }
})

test('便携安装卸载时保留 data，不连带删除', () => {
  const root = tempDir('if-install-portable-')
  try {
    const pkg = join(root, 'pkg')
    write(join(pkg, 'VERSION'), '0.0.1\n')
    write(join(pkg, 'In_Fate', 'VERSION'), '0.0.1\n')
    write(join(pkg, 'In_Fate', 'bin', 'if.ts'), '// if\n')
    write(join(pkg, 'config', 'if.release.json'), '{}\n')
    write(join(pkg, 'tools', 'install.mjs'), readFileSync(installScript, 'utf8'))
    write(join(pkg, 'tools', 'apply-pending.mjs'), readFileSync(applyScript, 'utf8'))

    const installDir = join(root, 'portable')
    const install = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', installDir,
      '--portable',
      '--no-shortcuts',
      '--no-registry',
      '--quiet',
    ], { encoding: 'utf8' })
    assert.equal(install.status, 0, install.stderr)
    write(join(installDir, 'data', 'marker.txt'), 'keep me\n')
    // 元数据丢失时也要靠布局回退保住 data/。
    rmSync(join(installDir, 'install.json'), { force: true })
    rmSync(join(installDir, 'if-home.txt'), { force: true })

    const uninstall = spawnSync(process.execPath, [
      join(installDir, 'tools', 'install.mjs'),
      '--uninstall',
      '--no-shortcuts',
      '--no-registry',
      '--quiet',
      '--dir', installDir,
    ], { encoding: 'utf8' })
    assert.equal(uninstall.status, 0, uninstall.stderr)
    assert.equal(existsSync(join(installDir, 'data', 'marker.txt')), true)
    assert.equal(existsSync(join(installDir, 'In_Fate')), false)
    assert.equal(existsSync(join(installDir, 'config')), false)
  } finally {
    cleanup(root)
  }
})

test('安装器拒绝覆盖无关目录', () => {
  const root = tempDir('if-install-guard-')
  try {
    const pkg = join(root, 'pkg')
    write(join(pkg, 'VERSION'), '0.0.1\n')
    write(join(pkg, 'In_Fate', 'VERSION'), '0.0.1\n')
    write(join(pkg, 'In_Fate', 'bin', 'if.ts'), '// if\n')
    write(join(pkg, 'config', 'if.release.json'), '{}\n')
    write(join(pkg, 'tools', 'install.mjs'), readFileSync(installScript, 'utf8'))
    write(join(pkg, 'tools', 'apply-pending.mjs'), readFileSync(applyScript, 'utf8'))

    const occupied = join(root, 'occupied')
    write(join(occupied, 'notes.txt'), 'do not touch\n')
    const result = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', occupied,
      '--no-shortcuts',
      '--no-registry',
      '--quiet',
    ], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(join(occupied, 'notes.txt'), 'utf8'), 'do not touch\n')
    assert.equal(existsSync(join(occupied, 'In_Fate')), false)
  } finally {
    cleanup(root)
  }
})

test('安装器 --dry-run 只检查，不创建安装目录', () => {
  const root = tempDir('if-install-dry-run-')
  try {
    const pkg = makePackage(root)
    const installDir = join(root, 'installed')
    const result = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', installDir,
      '--dry-run',
      '--no-shortcuts',
      '--no-registry',
      '--quiet',
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(installDir), false)
  } finally {
    cleanup(root)
  }
})

test('安装器一键写入并验证快捷方式与卸载登记，repair 可恢复，卸载可清理', {
  skip: isWindows ? false : '仅 Windows',
}, () => {
  const root = tempDir('if-install-windows-')
  const key = uniqueRegistryKey()
  const keyParent = key.replace(/\\In_Fate$/i, '')
  try {
    const pkg = makePackage(root)
    const installDir = join(root, 'installed')
    const dataDir = join(root, 'data')
    const desktopDir = join(root, 'desktop')
    const startMenuDir = join(root, 'start-menu')
    mkdirSync(desktopDir, { recursive: true })
    mkdirSync(startMenuDir, { recursive: true })
    const env = {
      ...process.env,
      IF_INSTALL_DESKTOP_DIR: desktopDir,
      IF_INSTALL_START_MENU_DIR: startMenuDir,
      IF_INSTALL_REGISTRY_KEY: key,
    }

    const install = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', installDir,
      '--data-dir', dataDir,
      '--no-launch',
      '--quiet',
    ], { encoding: 'utf8', env })
    assert.equal(install.status, 0, install.stderr)

    const desktopShortcut = join(desktopDir, 'In_Fate.lnk')
    const startShortcut = join(startMenuDir, 'In_Fate.lnk')
    assert.equal(existsSync(desktopShortcut), true)
    assert.equal(existsSync(startShortcut), true)

    const info = JSON.parse(readFileSync(join(installDir, 'install.json'), 'utf8')) as {
      installer: {
        shortcuts: Array<{ label: string }>
        registry: { key: string } | null
      }
    }
    assert.equal(info.installer.shortcuts.length, 2)
    assert.equal(info.installer.registry?.key, key.replace(/^HKCU\\/, 'HKCU:\\'))

    const query = spawnSync(regExe, ['query', key], { encoding: 'utf8' })
    assert.equal(query.status, 0, query.stderr)
    assert.match(query.stdout, /DisplayName\s+REG_SZ\s+In_Fate/)
    assert.match(query.stdout, /UninstallString\s+REG_SZ/)

    const shortcut = readShortcut(desktopShortcut, root)
    assert.match(shortcut.target, /wscript\.exe/i)
    assert.match(shortcut.arguments, /start-desktop\.vbs/i)

    write(join(dataDir, 'marker.txt'), 'keep me\n')
    rmSync(desktopShortcut, { force: true })
    rmSync(startShortcut, { force: true })
    deleteRegistryKey(key)

    const repair = spawnSync(process.execPath, [
      join(installDir, 'tools', 'install.mjs'),
      '--repair',
      '--dir', installDir,
      '--no-launch',
      '--quiet',
    ], { encoding: 'utf8', env })
    assert.equal(repair.status, 0, repair.stderr)
    assert.equal(existsSync(desktopShortcut), true)
    assert.equal(existsSync(startShortcut), true)
    assert.equal(spawnSync(regExe, ['query', key], { encoding: 'utf8' }).status, 0)
    assert.equal(readFileSync(join(dataDir, 'marker.txt'), 'utf8'), 'keep me\n')

    const uninstall = spawnSync(process.execPath, [
      join(installDir, 'tools', 'install.mjs'),
      '--uninstall',
      '--dir', installDir,
      '--quiet',
    ], { encoding: 'utf8', env })
    assert.equal(uninstall.status, 0, uninstall.stderr)
    assert.equal(existsSync(desktopShortcut), false)
    assert.equal(existsSync(startShortcut), false)
    assert.notEqual(spawnSync(regExe, ['query', key], { encoding: 'utf8' }).status, 0)
    assert.equal(existsSync(installDir), false)
    assert.equal(readFileSync(join(dataDir, 'marker.txt'), 'utf8'), 'keep me\n')
  } finally {
    deleteRegistryKey(key)
    deleteRegistryKey(keyParent)
    cleanup(root)
  }
})

test('Windows 集成预检失败时安装器不动程序层', {
  skip: isWindows ? false : '仅 Windows',
}, () => {
  const root = tempDir('if-install-preflight-')
  const key = uniqueRegistryKey()
  const keyParent = key.replace(/\\In_Fate$/i, '')
  try {
    const pkg = makePackage(root)
    const installDir = join(root, 'installed')
    const blockedDesktop = join(root, 'desktop-is-a-file')
    const startMenuDir = join(root, 'start-menu')
    write(blockedDesktop, 'not a directory\n')
    mkdirSync(startMenuDir, { recursive: true })
    const result = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', installDir,
      '--no-launch',
      '--quiet',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // 让 preflight 在“文件下面建目录”时失败，确保它发生在复制程序之前。
        IF_INSTALL_DESKTOP_DIR: join(blockedDesktop, 'nested'),
        IF_INSTALL_START_MENU_DIR: startMenuDir,
        IF_INSTALL_REGISTRY_KEY: key,
      },
    })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(installDir), false)
    assert.equal(existsSync(join(installDir, 'In_Fate')), false)
    assert.notEqual(
      spawnSync(regExe, ['query', key], { encoding: 'utf8' }).status,
      0,
      'preflight must not create the real uninstall key',
    )
  } finally {
    deleteRegistryKey(key)
    deleteRegistryKey(keyParent)
    cleanup(root)
  }
})

test('注册步骤失败时安装器回滚程序层', {
  skip: isWindows ? false : '仅 Windows',
}, () => {
  const root = tempDir('if-install-rollback-')
  const key = uniqueRegistryKey()
  const keyParent = key.replace(/\\In_Fate$/i, '')
  try {
    const pkg = makePackage(root)
    write(join(pkg, 'tools', 'windows-install.ps1'), `param(
  [string]$Action = 'Register',
  [string]$InstallDir = '',
  [string]$Version = '0.0.0',
  [string]$Icon = '',
  [string]$RegistryKey = '',
  [string]$DesktopDir = '',
  [string]$StartMenuDir = '',
  [string]$ResultPath = '',
  [switch]$NoShortcuts,
  [switch]$NoRegistry
)
$errors = @()
if ($Action -eq 'Register') { $errors += 'simulated register failure' }
$ok = $errors.Count -eq 0
$json = @{
  ok = $ok
  action = $Action
  errors = $errors
  warnings = @()
  shortcuts = @()
  registry = $null
} | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
if (-not $ok) { [Console]::Error.WriteLine('simulated register failure'); exit 1 }
exit 0
`)
    const installDir = join(root, 'installed')
    const result = spawnSync(process.execPath, [
      join(pkg, 'tools', 'install.mjs'),
      '--dir', installDir,
      '--no-launch',
      '--quiet',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        IF_INSTALL_DESKTOP_DIR: join(root, 'desktop'),
        IF_INSTALL_START_MENU_DIR: join(root, 'start-menu'),
        IF_INSTALL_REGISTRY_KEY: key,
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /simulated register failure/)
    assert.equal(existsSync(join(installDir, 'In_Fate')), false)
    assert.equal(existsSync(join(installDir, 'install.json')), false)
  } finally {
    deleteRegistryKey(key)
    deleteRegistryKey(keyParent)
    cleanup(root)
  }
})

test('单文件 exe 安装器能解压并通过参数安装到临时目录', {
  skip: canBuildSetupExe ? false : '需要 Windows csc / PowerShell',
}, () => {
  const root = tempDir('if-setup-exe-')
  try {
    const pkg = makePackage(root, '9.9.9')
    // 发布 zip 的顶层目录固定是 In_First；测试包本身是它的内容。
    const releaseRoot = join(root, 'zip-root', 'In_First')
    cpSync(pkg, releaseRoot, { recursive: true })
    const zip = join(root, 'package.zip')
    const setup = join(root, 'In_Fate-Setup.exe')
    const installed = join(root, 'installed')
    const data = join(root, 'data')

    const archive = spawnSync(powershellExe, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -LiteralPath '${releaseRoot}' -DestinationPath '${zip}' -Force`,
    ], { encoding: 'utf8' })
    assert.equal(archive.status, 0, archive.stderr)

    const build = spawnSync(process.execPath, [
      join(repoRoot, 'scripts', 'build-installer.mjs'),
      '--package', zip,
      '--out', setup,
    ], { encoding: 'utf8' })
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
    assert.equal(existsSync(setup), true)

    const run = spawnSync(setup, [
      '--dir', installed,
      '--data-dir', data,
      '--no-shortcuts',
      '--no-registry',
      '--no-launch',
      '--quiet',
    ], { encoding: 'utf8' })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(existsSync(join(installed, 'In_Fate', 'bin', 'if.ts')), true)
    const info = JSON.parse(readFileSync(join(installed, 'install.json'), 'utf8')) as { version: string }
    assert.equal(info.version, '9.9.9')
  } finally {
    cleanup(root)
  }
})
