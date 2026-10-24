import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAccess } from '../src/memory/access.ts'
import { MemoryProposalStore } from '../src/memory/proposals.ts'
import { MemoryStore, MemoryShardWriter } from '../src/memory/store.ts'
import { createMemoryTools } from '../src/memory/tools.ts'
import { InMemoryApprovalRegistry } from '../src/tools/approval.ts'
import { executeTool } from '../src/tools/executor.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fixture(): { root: string; store: MemoryStore; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'if-memory-'))
  mkdirSync(join(root, 'detail', 'test'), { recursive: true })
  writeFileSync(
    join(root, 'detail', 'test', 'notes.json'),
    `${JSON.stringify({
      project: 'test',
      filename: 'notes',
      introduction: '测试记忆',
      entries: [],
    }, null, 2)}\n`,
    'utf8',
  )
  const store = new MemoryStore(root, {
    now: () => new Date('2026-10-24T04:00:00.000Z'),
  })
  return {
    root,
    store,
    close: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

test('detail 记忆：搜索、追加、并发同目标串行、更新冲突', async () => {
  const ctx = fixture()
  try {
    const first = await ctx.store.add('detail:test/notes', {
      content: 'alpha 事实',
      tag: '确信',
    })
    assert.match(first.id, /^notes-\d{4}$/)

    const hits = ctx.store.search('alpha')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.id, first.id)

    await Promise.all([
      ctx.store.add('detail:test/notes', { content: '并发 A', tag: '可信' }),
      ctx.store.add('detail:test/notes', { content: '并发 B', tag: '可信' }),
    ])
    const doc = ctx.store.read('detail:test/notes')
    assert.equal(doc.entries.length, 3)
    assert.equal(new Set(doc.entries.map(entry => entry.id)).size, 3)

    const updated = await ctx.store.update('detail:test/notes', first.id, {
      content: 'alpha 已更新',
      expectedRevTime: null,
    })
    assert.ok(updated['rev-time'])
    await assert.rejects(
      ctx.store.update('detail:test/notes', first.id, {
        content: 'stale',
        expectedRevTime: null,
      }),
      /changed/,
    )
    assert.throws(() => ctx.store.read('detail:../evil'), /unsafe|outside/)
  } finally {
    ctx.close()
  }
})

test('不同 target 可以并行，MemoryShardWriter 只串行同 key', async () => {
  const writer = new MemoryShardWriter()
  const active = new Map<string, number>()
  let maxA = 0
  let maxB = 0
  const task = (key: string): Promise<void> => writer.run(key, async () => {
    active.set(key, (active.get(key) ?? 0) + 1)
    if (key === 'a') maxA = Math.max(maxA, active.get(key)!)
    if (key === 'b') maxB = Math.max(maxB, active.get(key)!)
    await sleep(20)
    active.set(key, (active.get(key) ?? 1) - 1)
  })
  await Promise.all([task('a'), task('a'), task('b'), task('b')])
  assert.equal(maxA, 1)
  assert.equal(maxB, 1)
})

test('MemoryGrant：默认 user=steward、agent=worker，可显式提升', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-grant-'))
  try {
    const file = join(dir, 'grants.json')
    const access = new MemoryAccess(file, id => ({
      createdBy: id === 'u' ? 'user' : 'agent',
      kind: id === 'u' ? 'user' : 'agent',
    }))
    assert.equal(access.roleFor('u'), 'steward')
    assert.equal(access.roleFor('a'), 'worker')
    assert.equal(access.canWrite('u', 'shared'), true)
    assert.equal(access.canWrite('a', 'shared'), false)
    access.grant('a', 'steward')
    assert.equal(access.canWrite('a', 'shared'), true)
    assert.match(readFileSync(file, 'utf8'), /"a": "steward"/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('memory 工具：steward 直写，worker 只能提议，提议可接受', async () => {
  const ctx = fixture()
  const grantsDir = mkdtempSync(join(tmpdir(), 'if-memory-tools-'))
  try {
    const access = new MemoryAccess(join(grantsDir, 'grants.json'), id => ({
      createdBy: id === 'user-session' ? 'user' : 'agent',
      kind: id === 'user-session' ? 'user' : 'agent',
    }))
    const proposals = new MemoryProposalStore(ctx.root)
    const tools = new ToolRegistry()
    for (const tool of createMemoryTools({ store: ctx.store, access, proposals })) {
      tools.register(tool)
    }
    const base = {
      registry: tools,
      approvals: new InMemoryApprovalRegistry(),
      cwd: grantsDir,
      sessionId: 'user-session',
    }

    const added = await executeTool('memory_add', {
      target: 'detail:test/notes',
      content: '用户直接写入',
      tag: '确信',
    }, { ...base, callId: 'c1' })
    assert.equal(Boolean(added.isError), false)

    const denied = await executeTool('memory_add', {
      target: 'detail:test/notes',
      content: 'worker 直写',
      tag: '可信',
    }, { ...base, callId: 'c2', sessionId: 'worker-session' })
    assert.equal(denied.isError, true)

    const proposed = await executeTool('memory_propose', {
      target: 'detail:test/notes',
      content: 'worker 提议',
      tag: '可信',
      reason: '测试',
    }, { ...base, callId: 'c3', sessionId: 'worker-session' })
    assert.equal(Boolean(proposed.isError), false)
    const pending = proposals.list('pending')
    assert.equal(pending.length, 1)

    const accepted = await proposals.accept(pending[0]!.proposalId, ctx.store)
    assert.match(accepted.id, /^notes-/)
    assert.equal(ctx.store.search('worker 提议').length, 1)
  } finally {
    rmSync(grantsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    ctx.close()
  }
})
