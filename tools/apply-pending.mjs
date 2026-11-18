/**
 * 启动前应用 pending 更新。
 *
 * 这个文件放在 <安装根>/tools/，不在 In_Fate 里，所以它自己永远不会
 * 被正在应用的更新替换。用法：
 *
 *   node tools/apply-pending.mjs <安装根>
 *
 * 布局：<安装根>/In_Fate 是程序，<安装根>/data 是数据。
 * 没有 pending.json 时直接退出 0。切换失败会尽量回滚并留下日志。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const installRoot = resolve(process.argv[2] ?? join(here, '..'))
const updatesDir = join(installRoot, '.updates')
const pendingPath = join(updatesDir, 'pending.json')
const currentDir = join(installRoot, 'In_Fate')
const previousDir = join(installRoot, 'previous')

function log(message) {
  try {
    mkdirSync(join(installRoot, 'logs'), { recursive: true })
    appendFileSync(join(installRoot, 'logs', 'update.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // 日志失败不影响更新
  }
}

function fail(message) {
  log(`FAIL ${message}`)
  console.error(`[update] ${message}`)
  process.exit(1)
}

function readPending() {
  try {
    return JSON.parse(readFileSync(pendingPath, 'utf8'))
  } catch {
    return undefined
  }
}

function versionOf(dir) {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function isProgram(dir) {
  return existsSync(join(dir, 'bin', 'if.ts')) && versionOf(dir) !== undefined
}

function inside(base, target) {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

function clearPending() {
  rmSync(pendingPath, { force: true })
}

function applyPending(pending) {
  if (pending.action !== 'apply') return false
  if (typeof pending.program !== 'string' || pending.program === '') {
    fail('pending 缺少 program')
  }
  const program = resolve(installRoot, pending.program)
  if (!inside(installRoot, program)) fail('pending 的 program 越界')
  if (!isProgram(program)) fail(`暂存程序不完整：${program}`)
  const version = versionOf(program)
  if (version !== pending.version) {
    fail(`暂存版本不匹配：期望 ${pending.version}，实际 ${version ?? '(缺失)'}`)
  }
  const currentVersion = versionOf(currentDir)
  if (currentVersion && pending.fromVersion && currentVersion !== pending.fromVersion) {
    fail(`当前版本 V${currentVersion} 与 pending 来源 V${pending.fromVersion} 不一致；保留 pending`)
  }

  rmSync(previousDir, { recursive: true, force: true })
  if (existsSync(currentDir)) {
    try {
      renameSync(currentDir, previousDir)
    } catch (error) {
      fail(`无法移走旧版本：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    renameSync(program, currentDir)
  } catch (error) {
    if (!existsSync(currentDir) && existsSync(previousDir)) {
      try {
        renameSync(previousDir, currentDir)
      } catch {
        // 回滚也失败，保留现场
      }
    }
    fail(`无法切换到新版本：${error instanceof Error ? error.message : String(error)}`)
  }

  rmSync(dirname(program), { recursive: true, force: true })
  clearPending()
  log(`apply ok: ${pending.fromVersion} -> ${pending.version}`)
  console.log(`[update] 已切换到 V${pending.version}；请重新启动 IF。`)
  return true
}

function rollbackPending(pending) {
  if (pending.action !== 'rollback') return false
  if (!isProgram(previousDir)) fail('没有可回滚的上一版本')
  const currentVersion = versionOf(currentDir)
  if (currentVersion && pending.fromVersion && currentVersion !== pending.fromVersion) {
    fail(`当前版本 V${currentVersion} 与 pending 来源 V${pending.fromVersion} 不一致；保留 pending`)
  }
  const failedDir = join(updatesDir, `failed-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  rmSync(failedDir, { recursive: true, force: true })
  if (existsSync(currentDir)) {
    try {
      renameSync(currentDir, failedDir)
    } catch (error) {
      fail(`无法移走当前版本：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    renameSync(previousDir, currentDir)
  } catch (error) {
    if (!existsSync(currentDir) && existsSync(failedDir)) {
      try {
        renameSync(failedDir, currentDir)
      } catch {
        // 保留现场
      }
    }
    fail(`无法回滚：${error instanceof Error ? error.message : String(error)}`)
  }
  rmSync(failedDir, { recursive: true, force: true })
  clearPending()
  log(`rollback ok: ${pending.fromVersion} -> ${pending.version}`)
  console.log(`[update] 已回滚到 V${pending.version}。`)
  return true
}

if (!existsSync(pendingPath)) process.exit(0)
const pending = readPending()
if (!pending) fail('pending.json 无法解析；请检查或删除它')
if (pending.action === 'apply') applyPending(pending)
else if (pending.action === 'rollback') rollbackPending(pending)
else fail(`未知的 pending.action：${String(pending.action)}`)
