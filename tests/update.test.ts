import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
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

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

test('版本比较按语义化版本，预发布版小于正式版', () => {
  assert.equal(compareVersions('0.0.1', '0.0.2') < 0, true)
  assert.equal(compareVersions('0.10.0', '0.9.9') > 0, true)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0') < 0, true)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0, true)
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
