import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAccess } from '../src/memory/access.ts'
import { MemoryPolicyStore } from '../src/memory/policy.ts'
import { MemoryProposalStore } from '../src/memory/proposals.ts'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { MemorySearchIndex } from '../src/memory/search-index.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { createMemoryTools } from '../src/memory/tools.ts'

test('记忆策略三级解析：session > agent > default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-policy-'))
  try {
    const root = join(dir, 'memory')
    ensureMemoryLayout(root)
    const policy = new MemoryPolicyStore(root)
    assert.equal(policy.resolve('s1', 'main').mode, 'rag-tool')
    policy.setDefault({ write: { approval: 'off' }, maxEntries: 8 })
    policy.setAgent('main', { mode: 'jev-push', jev: { enabled: 'always' } })
    policy.setSession('s1', { mode: 'off', maxEntries: 3 })
    assert.deepEqual(
      {
        mode: policy.resolve('s1', 'main').mode,
        maxEntries: policy.resolve('s1', 'main').maxEntries,
        approval: policy.resolve('s1', 'main').write.approval,
        jev: policy.resolve('s1', 'main').jev.enabled,
      },
      { mode: 'off', maxEntries: 3, approval: 'off', jev: 'always' },
    )
    assert.equal(policy.resolve('s2', 'main').mode, 'jev-push')
    assert.equal(policy.resolve('s2', 'other').mode, 'rag-tool')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('记忆工具：worker 默认只能 propose，approval off 后可直接写；off 模式拒绝检索', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-tools-policy-'))
  try {
    const root = join(dir, 'memory')
    ensureMemoryLayout(root)
    const store = new MemoryStore(root)
    const policy = new MemoryPolicyStore(root, { agentIdFor: () => 'main' })
    const access = new MemoryAccess(join(dir, 'grants.json'), sessionId =>
      sessionId === 'agent-session'
        ? { createdBy: 'agent:worker', kind: 'agent' }
        : { createdBy: 'user', kind: 'user' })
    const proposals = new MemoryProposalStore(root)
    const index = new MemorySearchIndex(root, store)
    const tools = new Map(createMemoryTools({
      store,
      access,
      proposals,
      policy,
      searchIndex: index,
    }).map(tool => [tool.name, tool]))
    const context = (sessionId: string) => ({
      sessionId,
      callId: 'call-1',
      cwd: dir,
      signal: new AbortController().signal,
    })
    const input = {
      target: 'detail:环境/测试',
      content: '在深夜写记忆系统',
      tag: '确信',
      introduction: '测试',
      quotes: [{ say: '深夜写记忆系统', 'log-addr': '2026-11-06-sess-1-1' }],
    }

    const denied = await tools.get('memory_add')!.run(input, context('agent-session'))
    assert.equal(denied.isError, true)

    policy.setDefault({ write: { approval: 'off' } })
    const written = await tools.get('memory_add')!.run(input, context('agent-session'))
    assert.equal(written.isError, undefined)

    // approval off 只放开有 propose 能力的会话；observer 仍是只读。
    access.grant('observer-session', 'observer')
    const observerDenied = await tools.get('memory_add')!.run(
      input,
      context('observer-session'),
    )
    assert.equal(observerDenied.isError, true)

    // shared 工具不能借 detail:_... 绕过私域隐藏。
    const privateDenied = await tools.get('memory_read')!.run(
      { target: 'detail:_私域/秘密' },
      context('user-session'),
    )
    assert.equal(privateDenied.isError, true)
    assert.match(privateDenied.text ?? '', /private memory target/)
    index.markDirty()

    const searched = await tools.get('memory_search')!.run(
      { query: '深夜' },
      context('user-session'),
    )
    assert.equal(searched.isError, undefined)
    assert.match(searched.text ?? '', /深夜写记忆系统/)

    policy.setDefault({ mode: 'off' })
    const off = await tools.get('memory_search')!.run(
      { query: '深夜' },
      context('user-session'),
    )
    assert.equal(off.isError, true)
    index.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
