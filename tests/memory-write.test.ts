import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
    assert.equal(accepted.kind, 'detail')
    if (accepted.kind === 'detail') assert.match(accepted.entry.id, /^notes-/)
    assert.equal(ctx.store.search('worker 提议').length, 1)
  } finally {
    rmSync(grantsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    ctx.close()
  }
})

test('身份记忆只改 section，并先备份', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'if-identity-'))
  try {
    writeFileSync(
      join(agentDir, 'SOUL.md'),
      '# Demo Agent\n\n## 我叫什么\n\n旧名字。\n\n## 我怎么说话\n\n精简。\n',
      'utf8',
    )
    const identity = new (await import('../src/memory/identity.ts')).MemoryIdentityStore(agentDir, {
      now: () => new Date('2026-10-24T04:00:00.000Z'),
    })
    const result = identity.apply({
      file: 'SOUL',
      section: '我叫什么',
      content: '新名字。',
    })
    assert.match(result.backup, /SOUL-identity-/)
    const text = identity.read('SOUL')
    assert.match(text, /新名字/)
    assert.doesNotMatch(text.split('## 我怎么说话')[0]!, /旧名字/)

    identity.apply({
      file: 'SOUL',
      section: '新的小节',
      content: '追加内容。',
      mode: 'append',
    })
    assert.match(identity.read('SOUL'), /## 新的小节\n\n追加内容。/)
  } finally {
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('identity proposal 由用户接受后落文件', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'if-identity-proposal-'))
  const ctx = fixture()
  try {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Demo Agent\n\n## 我叫什么\n\n旧名字。\n', 'utf8')
    const identity = new (await import('../src/memory/identity.ts')).MemoryIdentityStore(agentDir)
    const proposals = new MemoryProposalStore(agentDir)
    const proposal = proposals.proposeIdentity({
      target: 'identity:SOUL',
      sourceSession: 'worker',
      identity: { file: 'SOUL', section: '我叫什么', content: '新名字。' },
      reason: '测试身份提议',
    })
    const accepted = await proposals.accept(proposal.proposalId, ctx.store, identity)
    assert.equal(accepted.kind, 'identity')
    assert.match(identity.read('SOUL'), /新名字/)
    assert.equal(proposals.get(proposal.proposalId)?.status, 'accepted')

    // 重复 accept 返回原结果，不再写一次。
    const again = await proposals.accept(proposal.proposalId, ctx.store, identity)
    assert.equal(again.kind, 'identity')
    if (again.kind === 'identity') assert.equal(again.result.backup, accepted.kind === 'identity' ? accepted.result.backup : '')
    assert.equal(identity.read('SOUL').match(/新名字/g)?.length, 1)
  } finally {
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    ctx.close()
  }
})

test('identity proposal：apply 成功但状态没落盘，重试不重复追加', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'if-identity-recover-'))
  const ctx = fixture()
  try {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Demo Agent\n\n## 我叫什么\n\n旧名字。\n', 'utf8')
    const { MemoryIdentityStore } = await import('../src/memory/identity.ts')
    const identity = new MemoryIdentityStore(agentDir)
    const proposals = new MemoryProposalStore(agentDir)
    const patch = {
      file: 'SOUL' as const,
      section: '新小节',
      content: '只应出现一次。',
      mode: 'append' as const,
    }
    const proposal = proposals.proposeIdentity({
      target: 'identity:SOUL',
      sourceSession: 'worker',
      identity: patch,
      reason: '崩溃恢复测试',
    })

    // 模拟：applying 已落盘，apply 已改文件，accepted 还没写。
    const preview = identity.preview(patch)
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
    const path = join(agentDir, 'proposals', `${proposal.proposalId}.json`)
    writeFileSync(path, `${JSON.stringify({
      ...proposal,
      status: 'applying',
      beforeHash: hash(preview.before),
      afterHash: hash(preview.after),
      resultPath: preview.path,
    }, null, 2)}\n`, 'utf8')
    identity.apply(patch)

    const accepted = await proposals.accept(proposal.proposalId, ctx.store, identity)
    assert.equal(accepted.kind, 'identity')
    assert.equal(identity.read('SOUL').match(/只应出现一次。/g)?.length, 1)
    assert.equal(proposals.get(proposal.proposalId)?.status, 'accepted')
  } finally {
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    ctx.close()
  }
})

test('identity proposal：applying 期间目标被外部改过就拒绝自动处理', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'if-identity-conflict-'))
  const ctx = fixture()
  try {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Demo Agent\n\n## 我叫什么\n\n旧名字。\n', 'utf8')
    const { MemoryIdentityStore } = await import('../src/memory/identity.ts')
    const identity = new MemoryIdentityStore(agentDir)
    const proposals = new MemoryProposalStore(agentDir)
    const patch = { file: 'SOUL' as const, section: '我叫什么', content: '新名字。' }
    const proposal = proposals.proposeIdentity({
      target: 'identity:SOUL',
      sourceSession: 'worker',
      identity: patch,
      reason: '冲突测试',
    })

    const path = join(agentDir, 'proposals', `${proposal.proposalId}.json`)
    writeFileSync(path, `${JSON.stringify({
      ...proposal,
      status: 'applying',
      beforeHash: 'not-the-current-hash',
      afterHash: 'also-not',
      resultPath: join(agentDir, 'SOUL.md'),
    }, null, 2)}\n`, 'utf8')

    await assert.rejects(
      proposals.accept(proposal.proposalId, ctx.store, identity),
      /changed while applying/,
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    ctx.close()
  }
})

test('detail 记忆：文件索引与整文件保存', async () => {
  const ctx = fixture()
  try {
    const first = await ctx.store.add('detail:test/notes', {
      content: 'alpha 事实',
      tag: '确信',
    })
    const list = ctx.store.listDocuments()
    assert.equal(list.length, 1)
    assert.equal(list[0]?.domain, 'test')
    assert.equal(list[0]?.filename, 'notes')
    assert.equal(list[0]?.target, 'detail:test/notes')
    assert.equal(list[0]?.entries, 1)

    const doc = ctx.store.read('detail:test/notes')
    const saved = await ctx.store.saveDocument('detail:test/notes', {
      ...doc,
      introduction: '改过的简介',
      entries: [
        { ...doc.entries[0]!, content: 'alpha 改过', tag: '可信' },
        {
          id: 'notes-0099',
          'rec-time': '2026-10-24 12:01',
          'rev-time': null,
          at: null,
          tag: '有疑',
          content: '新增条目',
          quotes: [],
        },
      ],
    })
    assert.equal(saved.document.entries.length, 2)
    assert.equal(saved.document.introduction, '改过的简介')
    const reread = ctx.store.read('detail:test/notes')
    assert.equal(reread.entries[1]?.content, '新增条目')
    assert.equal(ctx.store.listDocuments()[0]?.entries, 2)

    await assert.rejects(
      ctx.store.saveDocument('detail:test/notes', {
        ...reread,
        entries: [{ ...reread.entries[0]!, content: '' }],
      }),
      /validation failed/,
    )
    await assert.rejects(
      ctx.store.saveDocument('detail:test/notes', {
        ...reread,
        filename: 'other',
      }),
      /filename mismatch/,
    )
    assert.equal(ctx.store.read('detail:test/notes').entries.length, 2)
    assert.equal(first.id, 'notes-0001')
  } finally {
    ctx.close()
  }
})
