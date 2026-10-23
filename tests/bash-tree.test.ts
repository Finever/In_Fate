import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bashTool } from '../src/tools/builtin/bash.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(path: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('中断时连孙子进程一起终止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-bash-tree-'))
  const pidFile = join(dir, 'pid.txt')
  const controller = new AbortController()
  const context = {
    sessionId: 'test',
    callId: 'call',
    cwd: dir,
    signal: controller.signal,
  }

  try {
    writeFileSync(
      join(dir, 'child.js'),
      "require('fs').writeFileSync('pid.txt', String(process.pid));setInterval(()=>{},1000)\n",
      'utf8',
    )
    const running = bashTool.run({ command: 'node child.js' }, context)

    await waitFor(pidFile)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(pid > 0)
    assert.equal(alive(pid), true)

    controller.abort(new Error('tool timeout'))
    const result = await running
    const structured = result.structured as {
      terminated?: { reason: string; tree: boolean }
    }

    assert.equal(result.isError, true)
    assert.equal(structured.terminated?.reason, 'timeout')

    const deadline = Date.now() + 3_000
    while (alive(pid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(alive(pid), false, `child process ${pid} survived abort`)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
