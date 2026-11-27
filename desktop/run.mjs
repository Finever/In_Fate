/**
 * 启动 Electron 的小垫片。
 *
 * 有些终端环境会带 ELECTRON_RUN_AS_NODE=1，
 * 直接 `electron .` 会被当成 Node 跑，不开窗口。这里显式清掉这两个变量，
 * 再启动真正的 Electron 二进制。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'node_modules', 'electron', 'dist')
const exe = process.platform === 'win32'
  ? join(dist, 'electron.exe')
  : process.platform === 'darwin'
    ? join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(dist, 'electron')

if (!existsSync(exe)) {
  console.error(
    'Electron 二进制没有安装。\n'
    + '在 desktop 目录运行：\n'
    + '  npm install\n'
    + '如果下载卡住，用镜像：\n'
    + '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install\n',
  )
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE

const child = spawn(exe, [here, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
})

child.on('error', error => {
  console.error(`启动 Electron 失败：${error.message}`)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 0))
