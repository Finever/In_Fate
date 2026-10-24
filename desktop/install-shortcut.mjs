/**
 * 跨过 PATH 里的 powershell 差异：用绝对路径调 Windows PowerShell，
 * 执行 install-shortcut.ps1。
 *
 * 用法：
 *   node desktop/install-shortcut.mjs
 *   node desktop/install-shortcut.mjs --remove
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error('快捷启动安装器只支持 Windows。')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'install-shortcut.ps1')
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

if (!existsSync(powershell)) {
  console.error(`找不到 PowerShell：${powershell}`)
  process.exit(1)
}

const args = [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', script,
  ...(process.argv.includes('--remove') ? ['-Remove'] : []),
]

const child = spawn(powershell, args, { stdio: 'inherit', windowsHide: true })
child.on('error', error => {
  console.error(`启动 PowerShell 失败：${error.message}`)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 0))
