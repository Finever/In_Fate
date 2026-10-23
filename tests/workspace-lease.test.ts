import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceLeaseManager } from '../src/core/workspace-lease.ts'
import { InMemoryApprovalRegistry } from '../src/tools/approval.ts'
import { executeTool } from '../src/tools/executor.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function manager(): { leases: WorkspaceLeaseManager; dir: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'if-lease-'))
  return {
    dir,
    leases: new WorkspaceLeaseManager({ pathTtlMs: 2_000, workspaceTtlMs: 2_000, waitMs: 500 }),
    close: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

function req(scope: 'path' | 'workspace', target: string | undefined, session = 's1', tool = 't1') {
  return {
    workspaceId: 'ws',
    scope,
    ...(target ? { target } : {}),
    sessionId: session,
    toolCallId: tool,
  }
}

test('不同路径并行，同路径排队', async () => {
  const ctx = manager()
  try {
    const a = await ctx.leases.acquire(req('path', join(ctx.dir, 'a.txt'), 's1', 'a'))
    const b = await ctx.leases.acquire(req('path', join(ctx.dir, 'b.txt'), 's2', 'b'))
    assert.equal(ctx.leases.snapshot('ws').length, 2)

    let acquired = false
    const waiting = ctx.leases.acquire(req('path', join(ctx.dir, 'a.txt'), 's2', 'c'))
      .then(lease => { acquired = true; return lease })
    await sleep(30)
    assert.equal(acquired, false)

    a.release()
    const c = await waiting
    assert.equal(acquired, true)
    c.release()
    b.release()
  } finally {
    ctx.close()
  }
})

test('workspace 独占锁阻塞路径锁，路径锁也阻塞整仓锁', async () => {
  const ctx = manager()
  try {
    const path = await ctx.leases.acquire(req('path', join(ctx.dir, 'a.txt'), 's1', 'p1'))
    let workspaceAcquired = false
    const workspace = ctx.leases.acquire(req('workspace', undefined, 's2', 'w1'))
      .then(lease => { workspaceAcquired = true; return lease })
    await sleep(30)
    assert.equal(workspaceAcquired, false)

    path.release()
    const w = await workspace
    assert.equal(workspaceAcquired, true)

    let pathAcquired = false
    const path2 = ctx.leases.acquire(req('path', join(ctx.dir, 'b.txt'), 's3', 'p2'))
      .then(lease => { pathAcquired = true; return lease })
    await sleep(30)
    assert.equal(pathAcquired, false)

    w.release()
    const p = await path2
    assert.equal(pathAcquired, true)
    p.release()
  } finally {
    ctx.close()
  }
})

test('等待超时与 abort 都会释放排队', async () => {
  const ctx = manager()
  try {
    const held = await ctx.leases.acquire(req('path', join(ctx.dir, 'a.txt'), 's1', 'held'))
    const short = new WorkspaceLeaseManager({ waitMs: 20 })
    const heldShort = await short.acquire(req('path', join(ctx.dir, 'a.txt'), 's1', 'held-short'))
    await assert.rejects(
      short.acquire(req('path', join(ctx.dir, 'a.txt'), 's2', 'timeout')),
      /timeout/,
    )
    heldShort.release()
    short.dispose()

    const controller = new AbortController()
    const waiting = ctx.leases.acquire({
      ...req('path', join(ctx.dir, 'a.txt'), 's2', 'abort'),
      signal: controller.signal,
    })
    controller.abort(new Error('cancelled by test'))
    await assert.rejects(waiting, /cancelled by test/)
    held.release()
    assert.equal(ctx.leases.snapshot('ws').length, 0)
  } finally {
    ctx.close()
  }
})

test('TTL 到期后锁可被接管', async () => {
  const ctx = manager()
  try {
    const lease = await ctx.leases.acquire({
      ...req('path', join(ctx.dir, 'a.txt'), 's1', 'ttl'),
      ttlMs: 20,
    })
    assert.equal(ctx.leases.snapshot('ws').length, 1)
    await sleep(40)
    assert.equal(ctx.leases.snapshot('ws').length, 0)
    const next = await ctx.leases.acquire(req('path', join(ctx.dir, 'a.txt'), 's2', 'next'))
    next.release()
    lease.release()
  } finally {
    ctx.close()
  }
})

test('executeTool 按 meta.writeScope 取路径租约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-lease-tool-'))
  const leases = new WorkspaceLeaseManager({ waitMs: 500 })
  const tools = new ToolRegistry()
  let active = 0
  let maxActive = 0
  tools.register({
    name: 'probe_write',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
      additionalProperties: false,
    },
    meta: { writeScope: 'path' },
    async run() {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(40)
      active -= 1
      return { text: 'ok' }
    },
  })

  try {
    const base = {
      registry: tools,
      approvals: new InMemoryApprovalRegistry(),
      cwd: dir,
      leases,
      workspaceId: 'ws',
    }
    const [first, second] = await Promise.all([
      executeTool('probe_write', { file_path: 'a.txt' }, { ...base, callId: 'c1', sessionId: 's1' }),
      executeTool('probe_write', { file_path: 'a.txt' }, { ...base, callId: 'c2', sessionId: 's2' }),
    ])
    assert.equal(Boolean(first.isError), false)
    assert.equal(Boolean(second.isError), false)
    assert.equal(maxActive, 1)
    assert.equal(leases.snapshot('ws').length, 0)
  } finally {
    leases.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
