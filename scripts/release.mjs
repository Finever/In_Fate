/**
 * 生成可独立启动、可安全替换程序的发布包。
 *
 * 目录：release/In_First/
 *   In_Fate/       程序（bin/src/ui/dist/desktop/package）
 *   data/          可变数据根（更新时永远不碰）
 *   runtime/       当前平台 Node（尽量拷贝；失败则回退 node）
 *   config/        可变配置
 *   logs/ backups/ 运行日志与迁移备份
 *   start-*        启动脚本
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
if (!/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION is not a supported version: ${version}`)
}
const includeDesktop = !process.argv.includes('--no-desktop')
const outRoot = join(root, 'release')
const outName = 'In_First'
const out = join(outRoot, outName)
const appDir = join(out, 'In_Fate')

function copy(relative, target = relative) {
  const from = join(root, relative)
  const to = join(out, target)
  if (!existsSync(from)) throw new Error(`missing release input: ${relative}`)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

function write(relative, text) {
  const target = join(out, relative)
  mkdirSync(dirname(target), { recursive: true })
  // Windows 批处理用 CRLF；.cmd 里不要放中文，避免 CMD 代码页把行拆坏。
  const content = relative.endsWith('.cmd') ? text.replace(/\r?\n/g, '\r\n') : text
  writeFileSync(target, content, 'utf8')
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function makeZip() {
  const zip = join(outRoot, `${outName}-v${version}-${process.platform}-${process.arch}.zip`)
  rmSync(zip, { force: true })
  let result
  if (process.platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    result = spawnSync(powershell, [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath ${quote(out)} -DestinationPath ${quote(zip)} -Force`,
    ], { stdio: 'inherit' })
  } else {
    result = spawnSync('zip', ['-r', '-q', zip, outName], {
      cwd: outRoot,
      stdio: 'inherit',
    })
  }
  if (result.status !== 0) {
    console.warn(`[release] zip failed (status ${result.status ?? '?'}); folder is ready: ${out}`)
    return undefined
  }
  return zip
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
mkdirSync(appDir, { recursive: true })

if (!existsSync(join(root, 'ui', 'dist', 'index.html'))) {
  throw new Error('ui/dist is missing; run `npm run build:ui` first')
}

// 程序目录：In_First/In_Fate 是一个整体，更新时只替换它。
copy('bin', 'In_Fate/bin')
copy('src', 'In_Fate/src')
copy('ui/dist', 'In_Fate/ui/dist')
copy('VERSION', 'In_Fate/VERSION')
copy('package-lock.json', 'In_Fate/package-lock.json')
copy('docs')
copy('LICENSE')
copy('VERSION')
copy('README.md', 'PROJECT.md')
copy('scripts/release-smoke.mjs', 'smoke.mjs')
copy('tools', 'tools')

// 运行时与可变目录。
const runtimeDir = join(out, 'runtime')
mkdirSync(runtimeDir, { recursive: true })
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
let runtimeIncluded = false
try {
  cpSync(process.execPath, join(runtimeDir, nodeName))
  runtimeIncluded = true
} catch (error) {
  console.warn(`[release] could not copy Node runtime: ${String(error)}`)
}
for (const dir of ['data', 'logs', 'backups', 'config']) {
  mkdirSync(join(out, dir), { recursive: true })
}
write('data/.keep', '')
write('logs/.keep', '')
write('backups/.keep', '')
copy('config/if.release.json', 'config/if.release.json')

// 桌面壳：程序在 In_Fate/desktop，数据在包根 data/。
let desktopIncluded = false
const electronDist = join(root, 'desktop', 'node_modules', 'electron', 'dist')
if (includeDesktop && existsSync(electronDist)) {
  mkdirSync(join(appDir, 'desktop', 'node_modules', 'electron'), { recursive: true })
  for (const file of ['main.mjs', 'preload.cjs', 'run.mjs', 'package.json', 'if-w3.ico', 'if-w3.png']) {
    copy(join('desktop', file), join('In_Fate', 'desktop', file))
  }
  cpSync(electronDist, join(appDir, 'desktop', 'node_modules', 'electron', 'dist'), { recursive: true })
  desktopIncluded = true
} else if (includeDesktop) {
  console.warn('[release] desktop/electron dist not found; use --no-desktop or install desktop deps')
}

// 程序自己的 package.json。
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
write('In_Fate/package.json', `${JSON.stringify({
  name: packageJson.name,
  version,
  private: true,
  type: 'module',
  engines: packageJson.engines,
  scripts: {
    start: 'node bin/if.ts serve -c ../config/if.release.json --port 8787 --ui-dir ui/dist',
    smoke: 'node ../smoke.mjs',
  },
  dependencies: packageJson.dependencies ?? {},
}, null, 2)}\n`)

write('release.json', `${JSON.stringify({
  name: 'In_Fate',
  version,
  builtAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  runtimeIncluded,
  desktopIncluded,
  appDir: 'In_Fate',
  entry: 'In_Fate/bin/if.ts',
  ui: 'In_Fate/ui/dist',
  config: 'config/if.release.json',
  data: 'data',
  installer: {
    entry: 'tools/install.mjs',
    windowsIntegration: 'tools/windows-install.ps1',
    schema: 2,
  },
}, null, 2)}\n`)

write('start-if.cmd', `@echo off
setlocal
cd /d "%~dp0"
set "IF_HOME=%~dp0data"
set "IF_PORTABLE=1"
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
`)

write('start-if.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
export IF_HOME="$PWD/data"
export IF_PORTABLE=1
export IF_CONFIG="$PWD/config/if.release.json"
if [ -x ./runtime/node ]; then
  NODE=./runtime/node
else
  NODE=node
fi
"$NODE" tools/apply-pending.mjs "$PWD"
exec "$NODE" In_Fate/bin/if.ts serve -c config/if.release.json --port 8787 --ui-dir In_Fate/ui/dist
`)
chmodSync(join(out, 'start-if.sh'), 0o755)

if (desktopIncluded) {
  write('start-desktop.cmd', `@echo off
setlocal
cd /d "%~dp0"
set "IF_HOME=%~dp0data"
set "IF_PORTABLE=1"
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
`)
  write('start-desktop.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
export IF_HOME="$PWD/data"
export IF_PORTABLE=1
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
`)
  chmodSync(join(out, 'start-desktop.sh'), 0o755)
}

write('install.cmd', `@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0tools\\install.mjs" %*
if errorlevel 1 (
  echo.
  echo Install failed. Press any key to close.
  pause
)
`)

write('install.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ -x ./runtime/node ]; then
  NODE=./runtime/node
else
  NODE=node
fi
exec "$NODE" tools/install.mjs "$@"
`)
chmodSync(join(out, 'install.sh'), 0o755)

write('README.md', `# In_Fate V${version} 发布包

这是 ${new Date().toISOString().slice(0, 10)} 生成的发布包。程序、运行时、数据分开存放；升级只替换 \`In_Fate\`，不要碰 \`data/\`。

## 安装到本机（推荐）

- Windows：双击 \`install.cmd\`
- Linux/macOS：\`./install.sh\`
- 如果拿到的是 \`In_Fate-Setup-v*.exe\`，双击它即可；它会自解压到临时目录，再调用本包的 \`install.cmd\`。

默认安装到 \`%USERPROFILE%\\In_First\`：程序在 \`%USERPROFILE%\\In_First\\In_Fate\`，数据在 \`%USERPROFILE%\\In_First\\data\`；不请求管理员权限，也不进 AppData。

安装器会创建桌面与开始菜单快捷方式，并在 \`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\In_Fate\` 写入卸载登记。每一步写入后都会回读验证；失败会报错、撤销本次登记并回滚程序层，不会假装安装成功。诊断记录在 \`logs/install.log\`。

可选参数：

\`\`\`text
--dir <目录>        安装目录
--data-dir <目录>   数据目录
--portable          就地注册当前发布包（根就是解压目录）
--repair            修复安装：重建启动脚本、快捷方式、卸载登记，不复制程序
--dry-run           只检查，不写文件
--force             目标目录非空且不像 In_First 安装根时仍然写入；卸载时强行继续
--no-shortcuts      不创建快捷方式
--no-registry       不写卸载注册表
--uninstall         卸载（默认保留 data；加 --purge 连数据一起删）
\`\`\`

安装根的 \`repair.cmd\` 可以在快捷方式或卸载登记丢失时重建它们；\`uninstall.cmd\` 默认保留数据，\`uninstall.cmd --purge\` 才会删数据。

## 免安装运行

### 桌面版

- Windows：双击 \`start-desktop.cmd\`
- Linux/macOS：\`./start-desktop.sh\`

### 浏览器 / CLI

- Windows：双击 \`start-if.cmd\`
- Linux/macOS：\`./start-if.sh\`

然后打开终端里打印的地址。

## 目录

\`\`\`text
In_Fate/   程序（更新时替换）
.updates/  下载中的更新包与 pending（运行时生成）
previous/  上一版本（可回滚）
runtime/       包内 Node
config/        配置
data/          数据根：会话、记忆、插件数据（更新时不要覆盖）
logs/          运行日志
backups/       数据备份（预留）
tools/         安装器与启动前更新切换
\`\`\`

## 数据位置

默认 \`IF_HOME\` 是包根下的 \`data/\`。可以显式覆盖：

\`\`\`text
set IF_HOME=D:\\In_Fate_Data
\`\`\`

安装版把 \`IF_HOME\` 指到 \`%USERPROFILE%\\In_First\\data\`；便携版保持包内即可。

## 更新

- 设置 → 关于与更新：填更新清单地址后可以检查、下载、应用更新；也可以直接选择本地更新包。
- 更新包先解压到 \`.updates\`，写入 pending；下次用 \`start-*.cmd\` 启动时由 \`tools/apply-pending.mjs\` 切换 \`In_Fate\`，运行中的进程不替换自己的文件。
- 上一版本留在 \`previous\`，可以在设置里回滚。
- 发布目录里的 \`latest.json\` 和 zip 放在同一地址即可；\`url\` 是相对路径，会按清单地址解析。

## 升级兼容

- 程序版本在 \`VERSION\`。
- 数据 schema 状态在 \`data/.state/data-schema.json\`。
- 旧数据需要迁移时，启动会先备份 schema 状态到 \`data/.state/backups\`；没有注册迁移会拒绝打开，不会静默改数据。
- \`data/\` 永远不随程序更新移动或覆盖。

## 冒烟测试

\`\`\`bash
./runtime/node smoke.mjs
# 或系统 node smoke.mjs
\`\`\`

## 可选依赖

本地 embedding 需要 \`node-llama-cpp\`。发布包默认不带 \`node_modules\`；核心功能不受影响，需要时在 \`In_Fate\` 执行：

\`\`\`bash
npm install --omit=dev
\`\`\`

## 版本

当前 \`${version}\`。
`)

const zip = makeZip()
let zipSha256
if (zip) {
  zipSha256 = await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(zip)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
  const zipName = zip.split(/[\\/]/).pop()
  // 更新清单和 zip 放在同一目录（release/），url 用相对路径，更新器按清单地址解析。
  writeFileSync(join(outRoot, 'latest.json'), `${JSON.stringify({
    version,
    url: zipName,
    sha256: zipSha256,
    size: fileSize(zip),
    publishedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  const releaseInfoPath = join(out, 'release.json')
  const releaseInfo = JSON.parse(readFileSync(releaseInfoPath, 'utf8'))
  releaseInfo.zip = {
    file: zipName,
    sha256: zipSha256,
    size: fileSize(zip),
  }
  writeFileSync(releaseInfoPath, `${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf8')
}

const nodeBytes = runtimeIncluded ? fileSize(join(runtimeDir, nodeName)) : 0
const electronBytes = desktopIncluded
  ? fileSize(join(appDir, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'))
  : 0

console.log(`[release] ${out}`)
console.log(`[release] app: ${appDir}`)
console.log(`[release] runtime: ${runtimeIncluded ? formatBytes(nodeBytes) : 'not copied (fallback to node)'}`)
console.log(`[release] desktop: ${desktopIncluded ? `yes (electron.exe ${formatBytes(electronBytes)})` : 'no'}`)
if (zip) console.log(`[release] zip: ${zip} (${formatBytes(fileSize(zip))}, sha256 ${zipSha256.slice(0, 12)}…)`)
if (zip) console.log(`[release] manifest: ${join(outRoot, 'latest.json')}`)
