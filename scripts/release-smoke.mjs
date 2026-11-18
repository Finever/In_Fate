/**
 * 发布包冒烟测试：独立启动后端，验证 health / version / UI 静态文件。
 *
 * 用法：
 *   node scripts/release-smoke.mjs [release/if-v0.0.1]
 *   ./runtime/node smoke.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = existsSync(join(scriptDir, 'bin', 'if.ts'))
  ? scriptDir
  : resolve(scriptDir, '..')

function latestRelease() {
  const releaseRoot = join(repoRoot, 'release')
  if (!existsSync(releaseRoot)) throw new Error('release/ does not exist; run `npm run release` first')
  const dirs = readdirSync(releaseRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^if-v\d+\.\d+\.\d+/.test(entry.name))
    .map(entry => ({ path: join(releaseRoot, entry.name), mtime: statSync(join(releaseRoot, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (dirs.length === 0) throw new Error('no release package found')
  return dirs[0].path
}

const target = process.argv[2] ? resolve(process.argv[2]) : latestRelease()
const version = readFileSync(join(target, 'VERSION'), 'utf8').trim()
const appDir = existsSync(join(target, 'app', 'current', 'bin', 'if.ts'))
  ? join(target, 'app', 'current')
  : target
const entry = join(appDir, 'bin', 'if.ts')
const config = join(target, 'config', 'if.release.json')
const uiDir = join(appDir, 'ui', 'dist')
for (const path of [entry, config, join(uiDir, 'index.html')]) {
  if (!existsSync(path)) throw new Error(`release is incomplete: ${path}`)
}

const child = spawn(process.execPath, [
  entry,
  'serve',
  '-c',
  config,
  '--port',
  '0',
  '--ui-dir',
  uiDir,
], {
  cwd: target,
  env: {
    ...process.env,
    IF_HOME: target,
    IF_PORTABLE: '1',
    IF_RELEASE_SMOKE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let stdout = ''
let stderr = ''
child.stdout?.setEncoding('utf8')
child.stderr?.setEncoding('utf8')
child.stdout?.on('data', chunk => { stdout += String(chunk) })
child.stderr?.on('data', chunk => { stderr += String(chunk) })

function waitFor(pattern, timeoutMs = 20_000) {
  const started = Date.now()
  return new Promise((resolvePromise, reject) => {
    const timer = setInterval(() => {
      const match = pattern.exec(stdout)
      if (match) {
        clearInterval(timer)
        resolvePromise(match)
        return
      }
      if (child.exitCode !== null) {
        clearInterval(timer)
        reject(new Error(`backend exited early (code ${child.exitCode})\n${stderr}`))
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timeout waiting for ${pattern}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
      }
    }, 100)
  })
}

async function stop() {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ])
}

try {
  const urlMatch = await waitFor(/IF UI API: (http:\/\/\S+)/)
  const tokenMatch = await waitFor(/Token: (\S+)/)
  const url = urlMatch[1]
  const token = tokenMatch[1]
  const headers = { authorization: `Bearer ${token}` }

  const health = await fetch(`${url}/api/health`, { headers })
  if (!health.ok) throw new Error(`health returned ${health.status}`)

  const versionResponse = await fetch(`${url}/api/version`, { headers })
  if (!versionResponse.ok) throw new Error(`version returned ${versionResponse.status}`)
  const info = await versionResponse.json()
  if (info.version !== version) {
    throw new Error(`version mismatch: package ${version}, server ${String(info.version)}`)
  }

  const ui = await fetch(`${url}/?token=${encodeURIComponent(token)}`)
  if (!ui.ok) throw new Error(`UI returned ${ui.status}`)
  const html = await ui.text()
  if (!html.includes('id="root"')) throw new Error('UI index.html is not the expected build')

  console.log(`smoke ok: In_Fate V${version} ${url}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await stop()
}
