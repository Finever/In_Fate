/**
 * 生成可独立启动的发布包。
 *
 * 目录：release/if-v<版本>/
 *   runtime/      当前平台的 Node（尽量拷贝；失败则启动脚本回退 node）
 *   bin/ src/     后端源码（Node 24 直接跑 TypeScript）
 *   ui/dist/      构建后的 UI
 *   config/       发布配置模板
 *   data/         独立数据根（空）
 *   desktop/      Electron 壳 + 自带 Electron dist（默认包含，可用 --no-desktop 跳过）
 *   smoke.mjs     独立启动冒烟测试
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

if (!existsSync(join(root, 'ui', 'dist', 'index.html'))) {
  throw new Error('ui/dist is missing; run `npm run build:ui` first')
}

copy('bin')
copy('src')
copy('ui/dist', 'ui/dist')
copy('docs')
copy('config/if.release.json', 'config/if.release.json')
copy('LICENSE')
copy('VERSION')
copy('README.md', 'PROJECT.md')
copy('package-lock.json')
copy('scripts/release-smoke.mjs', 'smoke.mjs')

// 运行时：尽量带上当前 Node，失败则回退到 PATH 里的 node。
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

// 发布配置：数据根在包内 data/，不碰开发目录。
mkdirSync(join(out, 'data'), { recursive: true })
write('data/.keep', '')

// Electron 桌面壳：默认带上自带 dist，避免目标机器再装 Electron。
let desktopIncluded = false
const electronDist = join(root, 'desktop', 'node_modules', 'electron', 'dist')
if (includeDesktop && existsSync(electronDist)) {
  mkdirSync(join(out, 'desktop', 'node_modules', 'electron'), { recursive: true })
  for (const file of ['main.mjs', 'preload.cjs', 'run.mjs', 'package.json', 'if-w3.ico', 'if-w3.png']) {
    copy(join('desktop', file), join('desktop', file))
  }
  cpSync(electronDist, join(out, 'desktop', 'node_modules', 'electron', 'dist'), { recursive: true })
  desktopIncluded = true
} else if (includeDesktop) {
  console.warn('[release] desktop/electron dist not found; use --no-desktop or install desktop deps')
}

// 发布用 package.json：不带 devDependencies，保留可选的本地 embedding 依赖。
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
write('package.json', `${JSON.stringify({
  name: packageJson.name,
  version,
  private: true,
  type: 'module',
  engines: packageJson.engines,
  scripts: {
    start: 'node bin/if.ts serve -c config/if.release.json --port 8787 --ui-dir ui/dist',
    smoke: 'node smoke.mjs',
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
  entry: 'bin/if.ts',
  ui: 'ui/dist',
  config: 'config/if.release.json',
}, null, 2)}\n`)

write('start-if.cmd', `@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\\node.exe" (
  set "NODE=%~dp0runtime\\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" bin\\if.ts serve -c config\\if.release.json --port 8787 --ui-dir ui\\dist
if errorlevel 1 pause
`)

write('start-if.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ -x ./runtime/node ]; then
  NODE=./runtime/node
else
  NODE=node
fi
exec "$NODE" bin/if.ts serve -c config/if.release.json --port 8787 --ui-dir ui/dist
`)
chmodSync(join(out, 'start-if.sh'), 0o755)

if (desktopIncluded) {
  write('start-desktop.cmd', `@echo off
setlocal
cd /d "%~dp0"
set "IF_CONFIG=%~dp0config\\if.release.json"
if exist "%~dp0runtime\\node.exe" (
  set "IF_NODE=%~dp0runtime\\node.exe"
) else (
  set "IF_NODE=node"
)
"%IF_NODE%" "%~dp0desktop\\run.mjs"
if errorlevel 1 pause
`)
  write('start-desktop.sh', `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
export IF_CONFIG="$PWD/config/if.release.json"
if [ -x ./runtime/node ]; then
  export IF_NODE="$PWD/runtime/node"
  exec ./runtime/node desktop/run.mjs
else
  export IF_NODE=node
  exec node desktop/run.mjs
fi
`)
  chmodSync(join(out, 'start-desktop.sh'), 0o755)
}

write('README.md', `# In_Fate V${version} 独立测试包

这是 ${new Date().toISOString().slice(0, 10)} 生成的发布包，数据、配置、运行时都在包内。

## 启动

### 桌面版

- Windows：双击 \`start-desktop.cmd\`
- Linux/macOS：\`./start-desktop.sh\`

桌面版使用包内 Electron，不要求系统另装 Node。

### 浏览器 / CLI

- Windows：双击 \`start-if.cmd\`
- Linux/macOS：\`./start-if.sh\`

然后打开终端里打印的 \`http://127.0.0.1:8787/?token=...\`。

## 配置

- 发布配置：\`config/if.release.json\`
- 数据根：\`data/\`
- 第一次启动没有模型服务商；在设置里添加 provider，然后在状态面板给 agent 选模型。
- 想改端口/数据路径，编辑 \`config/if.release.json\` 或启动脚本。

## 冒烟测试

\`\`\`bash
./runtime/node smoke.mjs
# 或系统 node smoke.mjs
\`\`\`

## 可选依赖

本地 embedding 需要 \`node-llama-cpp\`。发布包默认不带 \`node_modules\`，核心功能不受影响；
需要时在包根目录执行：

\`\`\`bash
npm install --omit=dev
\`\`\`

## 版本

版本号来源是包根目录的 \`VERSION\`；当前为 \`${version}\`。
`)

const zip = makeZip()
const nodeBytes = runtimeIncluded ? fileSize(join(runtimeDir, nodeName)) : 0
const electronBytes = desktopIncluded
  ? fileSize(join(out, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'))
  : 0

console.log(`[release] ${out}`)
console.log(`[release] runtime: ${runtimeIncluded ? formatBytes(nodeBytes) : 'not copied (fallback to node)'}`)
console.log(`[release] desktop: ${desktopIncluded ? `yes (electron.exe ${formatBytes(electronBytes)})` : 'no'}`)
if (zip) console.log(`[release] zip: ${zip} (${formatBytes(fileSize(zip))})`)
