/**
 * 生成可独立启动、可安全替换程序的发布包。
 *
 * 目录：release/if-v<版本>/
 *   app/current/   程序（bin/src/ui/dist/desktop/package）
 *   runtime/       当前平台 Node（尽量拷贝；失败则回退 node）
 *   config/        可变配置
 *   data/          可变数据根（更新时永远不碰）
 *   logs/ backups/ 运行日志与迁移备份
 *   start-*        启动脚本
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
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
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION is not semver: ${version}`)
}
const includeDesktop = !process.argv.includes('--no-desktop')
const outRoot = join(root, 'release')
const out = join(outRoot, `if-v${version}`)
const appDir = join(out, 'app', 'current')

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
  writeFileSync(target, text, 'utf8')
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
  const zip = join(outRoot, `if-v${version}-${process.platform}-${process.arch}.zip`)
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
    result = spawnSync('zip', ['-r', '-q', zip, `if-v${version}`], {
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

// 程序目录：更新时只替换 app/current 或新增 app/<version>。
copy('bin', 'app/current/bin')
copy('src', 'app/current/src')
copy('ui/dist', 'app/current/ui/dist')
copy('VERSION', 'app/current/VERSION')
copy('package-lock.json', 'app/current/package-lock.json')
copy('docs')
copy('LICENSE')
copy('VERSION')
copy('README.md', 'PROJECT.md')
copy('scripts/release-smoke.mjs', 'smoke.mjs')

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

// 桌面壳：程序在 app/current/desktop，数据在包根。
let desktopIncluded = false
const electronDist = join(root, 'desktop', 'node_modules', 'electron', 'dist')
if (includeDesktop && existsSync(electronDist)) {
  mkdirSync(join(appDir, 'desktop', 'node_modules', 'electron'), { recursive: true })
  for (const file of ['main.mjs', 'preload.cjs', 'run.mjs', 'package.json', 'if-w3.ico', 'if-w3.png']) {
    copy(join('desktop', file), join('app', 'current', 'desktop', file))
  }
  cpSync(electronDist, join(appDir, 'desktop', 'node_modules', 'electron', 'dist'), { recursive: true })
  desktopIncluded = true
} else if (includeDesktop) {
  console.warn('[release] desktop/electron dist not found; use --no-desktop or install desktop deps')
}

// 程序自己的 package.json。
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
write('app/current/package.json', `${JSON.stringify({
  name: packageJson.name,
  version,
  private: true,
  type: 'module',
  engines: packageJson.engines,
  scripts: {
    start: 'node bin/if.ts serve -c ../../config/if.release.json --port 8787 --ui-dir ui/dist',
    smoke: 'node ../../smoke.mjs',
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
  appDir: 'app/current',
  entry: 'app/current/bin/if.ts',
  ui: 'app/current/ui/dist',
  config: 'config/if.release.json',
  data: 'data',
}, null, 2)}\n`)

write('start-if.cmd', `@echo off
setlocal
cd /d "%~dp0"
set "IF_HOME=%~dp0"
set "IF_PORTABLE=1"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0app\\current\\bin\\if.ts" serve -c "%~dp0config\\if.release.json" --port 8787 --ui-dir "%~dp0app\\current\\ui\\dist"
if errorlevel 1 pause
`)

write('start-if.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
export IF_HOME="$PWD"
export IF_PORTABLE=1
if [ -x ./runtime/node ]; then
  NODE=./runtime/node
else
  NODE=node
fi
exec "$NODE" app/current/bin/if.ts serve -c config/if.release.json --port 8787 --ui-dir app/current/ui/dist
`)
chmodSync(join(out, 'start-if.sh'), 0o755)

if (desktopIncluded) {
  write('start-desktop.cmd', `@echo off
setlocal
cd /d "%~dp0"
set "IF_HOME=%~dp0"
set "IF_PORTABLE=1"
set "IF_CONFIG=%~dp0config\\if.release.json"
if exist "%~dp0runtime\\node.exe" (
  set "IF_NODE=%~dp0runtime\\node.exe"
) else (
  set "IF_NODE=node"
)
"%IF_NODE%" "%~dp0app\\current\\desktop\\run.mjs"
if errorlevel 1 pause
`)
  write('start-desktop.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
export IF_HOME="$PWD"
export IF_PORTABLE=1
export IF_CONFIG="$PWD/config/if.release.json"
if [ -x ./runtime/node ]; then
  export IF_NODE="$PWD/runtime/node"
  exec ./runtime/node app/current/desktop/run.mjs
else
  export IF_NODE=node
  exec node app/current/desktop/run.mjs
fi
`)
  chmodSync(join(out, 'start-desktop.sh'), 0o755)
}

write('README.md', `# In_Fate V${version} 独立测试包

这是 ${new Date().toISOString().slice(0, 10)} 生成的发布包。程序、运行时、数据分开存放；更新时只替换 \`app/current\`，不要碰 \`data/\`。

## 启动

### 桌面版

- Windows：双击 \`start-desktop.cmd\`
- Linux/macOS：\`./start-desktop.sh\`

### 浏览器 / CLI

- Windows：双击 \`start-if.cmd\`
- Linux/macOS：\`./start-if.sh\`

然后打开终端里打印的地址。

## 目录

\`\`\`text
app/current/   程序（可替换）
runtime/       包内 Node
config/        配置
data/          会话、记忆、插件数据（更新时不要覆盖）
logs/          运行日志（预留）
backups/       完整数据备份（预留）
\`\`\`

## 数据位置

默认 \`IF_HOME\` 是包根目录，数据在 \`data/\`。可以显式覆盖：

\`\`\`text
set IF_HOME=D:\\In_Fate_Data
\`\`\`

安装版以后可把 \`IF_HOME\` 指到 \`%LOCALAPPDATA%\\In_Fate\`；便携版保持包内即可。

## 升级兼容

- 程序版本在 \`VERSION\`。
- 数据 schema 状态在 \`data/.state/data-schema.json\`。
- 旧数据需要迁移时，启动会先备份 schema 状态到 \`data/.state/backups\`；没有注册迁移会拒绝打开，不会静默改数据。完整数据备份目录 \`backups/\` 是后续安装器/更新器的预留位。
- 更新流程：下载新版本到 \`app/<version>\`，校验后切换 \`app/current\`；\`data/\` 原样保留。

## 冒烟测试

\`\`\`bash
./runtime/node smoke.mjs
# 或系统 node smoke.mjs
\`\`\`

## 可选依赖

本地 embedding 需要 \`node-llama-cpp\`。发布包默认不带 \`node_modules\`；核心功能不受影响，需要时在 \`app/current\` 执行：

\`\`\`bash
npm install --omit=dev
\`\`\`

## 版本

当前 \`${version}\`。
`)

const zip = makeZip()
const nodeBytes = runtimeIncluded ? fileSize(join(runtimeDir, nodeName)) : 0
const electronBytes = desktopIncluded
  ? fileSize(join(appDir, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'))
  : 0

console.log(`[release] ${out}`)
console.log(`[release] app: ${appDir}`)
console.log(`[release] runtime: ${runtimeIncluded ? formatBytes(nodeBytes) : 'not copied (fallback to node)'}`)
console.log(`[release] desktop: ${desktopIncluded ? `yes (electron.exe ${formatBytes(electronBytes)})` : 'no'}`)
if (zip) console.log(`[release] zip: ${zip} (${formatBytes(fileSize(zip))})`)
