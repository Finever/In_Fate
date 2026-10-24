/**
 * IF Desktop —— Electron 壳的第一版。
 *
 * 它只做四件事：
 *   1. 拉起 `if serve`（系统 Node），随机端口 + 随机 token；
 *   2. 等 /api/health 通过；
 *   3. 用全屏窗口加载本地 UI；
 *   4. 退出时杀掉后端。
 *
 * 不做原生应用嵌入、不做多窗口、不做插件；那些等壳稳定后再加。
 */

import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const uiDir = join(repoRoot, 'ui', 'dist')
const uiIndex = join(uiDir, 'index.html')
const configPath = resolve(
  process.env.IF_CONFIG ?? join(repoRoot, 'config', 'if.local.json'),
)
const smoke = process.argv.includes('--smoke')
const nodeBin = process.env.IF_NODE ?? 'node'

let win
let serverProcess
let serverPort
let serverToken
let stopping = false
let logPath

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  try {
    if (logPath) appendFileSync(logPath, text, 'utf8')
  } catch {
    // 日志失败不影响启动
  }
  if (!app.isPackaged) process.stdout.write(text)
}

function ensureLogPath() {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  logPath = join(dir, 'if-desktop.log')
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(port, token, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) {
      throw new Error(`后端提前退出：code ${serverProcess.exitCode}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (response.ok) return
      lastError = `${response.status} ${response.statusText}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(250)
  }
  throw new Error(`等待后端超时：${lastError}`)
}

function startServer(port, token) {
  log(`spawn ${nodeBin} bin/if.ts serve -c ${configPath} --port ${port}`)
  const child = spawn(nodeBin, [
    join(repoRoot, 'bin', 'if.ts'),
    'serve',
    '-c',
    configPath,
    '--port',
    String(port),
    '--token',
    token,
    '--ui-dir',
    uiDir,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => log(`[server] ${String(chunk).trimEnd()}`))
  child.stderr?.on('data', chunk => log(`[server:err] ${String(chunk).trimEnd()}`))
  child.on('error', error => log(`[server] spawn error: ${error.message}`))
  child.on('exit', (code, signal) => {
    log(`[server] exit code=${code} signal=${signal ?? ''}`)
    if (!stopping && win && !win.isDestroyed()) {
      dialog.showErrorBox(
        'IF 后端已退出',
        `后端进程退出（code ${code ?? '?'}）。\n\n日志：${logPath ?? '(未初始化)'}`,
      )
    }
  })
  return child
}

function stopServer() {
  if (stopping) return
  stopping = true
  if (serverProcess && serverProcess.exitCode === null) {
    log('[server] stopping')
    try {
      serverProcess.kill()
    } catch {
      // 进程可能已经退出
    }
  }
}

function windowStatePath() {
  return join(app.getPath('userData'), 'window-state.json')
}

function readWindowState() {
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), 'utf8'))
    if (
      Number.isFinite(raw?.width) && Number.isFinite(raw?.height)
      && raw.width >= 800 && raw.height >= 560
    ) {
      return {
        width: Math.round(raw.width),
        height: Math.round(raw.height),
        x: Number.isFinite(raw?.x) ? Math.round(raw.x) : undefined,
        y: Number.isFinite(raw?.y) ? Math.round(raw.y) : undefined,
        maximized: raw?.maximized === true,
      }
    }
  } catch {
    // 没有状态文件
  }
  return { width: 1440, height: 900, maximized: false }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return
  const bounds = win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
  try {
    writeFileSync(windowStatePath(), JSON.stringify({
      ...bounds,
      maximized: win.isMaximized(),
    }, null, 2), 'utf8')
  } catch {
    // 状态保存失败不阻塞退出
  }
}

function createWindow(url) {
  const state = readWindowState()
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'In_Fate',
    backgroundColor: '#07090f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.setMenuBarVisibility(false)
  win.loadURL(url)

  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize()
    win.show()
    log(`ready: ${url}`)
    if (smoke) {
      setTimeout(() => app.quit(), 1500)
    }
  })

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(`http://127.0.0.1:${serverPort}`)) return
    event.preventDefault()
    if (/^https?:/i.test(target)) void shell.openExternal(target)
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      event.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    } else if (input.key === 'F12' && !app.isPackaged) {
      event.preventDefault()
      win.webContents.openDevTools({ mode: 'detach' })
    }
  })

  win.on('close', saveWindowState)
  win.on('closed', () => {
    win = undefined
  })
}

async function boot() {
  ensureLogPath()
  app.setAppUserModelId('com.in-fate.desktop')
  Menu.setApplicationMenu(null)

  if (!existsSync(configPath)) {
    dialog.showErrorBox(
      'IF 配置缺失',
      `找不到 ${configPath}\n\n请复制 config/if.example.json 为 config/if.local.json，并填好模型密钥。`,
    )
    app.quit()
    return
  }
  if (!existsSync(uiIndex)) {
    dialog.showErrorBox(
      'IF UI 未构建',
      `找不到 ${uiIndex}\n\n先在 ui 目录运行 npm run build。`,
    )
    app.quit()
    return
  }

  try {
    serverPort = Number(process.env.IF_PORT) || await freePort()
    serverToken = process.env.IF_TOKEN ?? randomBytes(18).toString('hex')
    serverProcess = startServer(serverPort, serverToken)
    await waitForHealth(serverPort, serverToken)
    createWindow(`http://127.0.0.1:${serverPort}/?token=${encodeURIComponent(serverToken)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`boot failed: ${message}`)
    dialog.showErrorBox(
      'IF 启动失败',
      `${message}\n\n配置：${configPath}\n日志：${logPath ?? '(未初始化)'}`,
    )
    stopServer()
    app.quit()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(boot)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort && serverToken) {
      createWindow(`http://127.0.0.1:${serverPort}/?token=${encodeURIComponent(serverToken)}`)
    }
  })

  app.on('before-quit', stopServer)
  app.on('window-all-closed', () => {
    stopServer()
    if (process.platform !== 'darwin') app.quit()
  })
}
