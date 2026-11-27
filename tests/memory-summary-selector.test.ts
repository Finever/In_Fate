import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_MEMORY_POLICY, MemoryPolicyStore, type ResolvedMemoryPolicy } from '../src/memory/policy.ts'
import { MemoryPushService } from '../src/memory/push.ts'
import { memoryPushSection } from '../src/context/memory-push.ts'
import { renderContext } from '../src/context/pipeline.ts'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { HeuristicMemorySelector } from '../src/memory/selector.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { MemorySummaryStore, type MemorySummaryGenerator } from '../src/memory/summary.ts'
import type { HistoryMessage } from '../src/projections/history.ts'

const fakeGenerator: MemorySummaryGenerator = {
  name: 'fake-model',
  async generateDocument({ entries }) {
    return entries.map(entry => ({
      entryId: entry.id,
      title: entry.id,
      summary: `模型摘要：${entry.content.slice(0, 80)}`,
      keywords: ['深夜', '代码'],
    }))
  },
}

function fixture(): {
  root: string
  store: MemoryStore
  summaries: MemorySummaryStore
  policy: ResolvedMemoryPolicy
  close: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'if-memory-selector-'))
  ensureMemoryLayout(root)
  const store = new MemoryStore(root)
  const summaries = new MemorySummaryStore({ root, store, generator: fakeGenerator })
  return {
    root,
    store,
    summaries,
    policy: {
      ...DEFAULT_MEMORY_POLICY,
      mode: 'jev-push',
      jev: { ...DEFAULT_MEMORY_POLICY.jev, enabled: 'once' },
    },
    close: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

function history(text: string): HistoryMessage[] {
  return [{
    role: 'user',
    content: [{ type: 'text', text }],
    origin: 'user',
  }]
}

test('摘要：生成到 summaries，选择器按查询命中，私域不进入推送', async () => {
  const ctx = fixture()
  try {
    await ctx.store.add('detail:环境/深夜', {
      content: '喜欢在深夜写代码，夜里安静',
      tag: '确信',
      introduction: '环境',
    })
    await ctx.store.add('detail:_私域/秘密', {
      content: '深夜的私密约定',
      tag: '确信',
      introduction: '私域',
    })
    const summary = (await ctx.summaries.ensure('detail:环境/深夜'))!
    assert.equal(summary.entries.length, 1)
    assert.equal(existsSync(join(ctx.root, 'summaries', '环境', '深夜.json')), true)
    assert.match(summary.entries[0]!.summary, /模型摘要/)

    const selector = new HeuristicMemorySelector({ store: ctx.store, summaries: ctx.summaries })
    const packet = selector.select({
      sessionId: 's1',
      history: history('深夜写代码'),
      policy: ctx.policy,
    })
    assert.ok(packet)
    assert.equal(packet.entries.some(entry => entry.target === 'detail:环境/深夜'), true)
    assert.equal(packet.entries.some(entry => entry.target.startsWith('detail:_')), false)
  } finally {
    ctx.close()
  }
})

test('Jev once：同段复用，压缩换段默认复用旧包，开启重分析才重选', async () => {
  const ctx = fixture()
  try {
    await ctx.store.add('detail:环境/深夜', {
      content: '深夜写代码',
      tag: '确信',
      introduction: '环境',
    })
    const summaries = new MemorySummaryStore({ root: ctx.root, store: ctx.store, generator: fakeGenerator })
    const selector = new HeuristicMemorySelector({ store: ctx.store, summaries })
    const policy = new MemoryPolicyStore(ctx.root)
    policy.setDefault({ mode: 'jev-push', jev: { enabled: 'once', reanalyzeOnCompaction: false } })
    let segment = 'initial'
    const push = new MemoryPushService({
      selector,
      policy,
      segmentKeyFor: () => segment,
    })
    const first = push.packetFor('s1', history('深夜写代码'))
    assert.ok(first)
    assert.equal(first.reused, false)

    segment = 'compacted-1'
    const second = push.packetFor('s1', history('深夜写代码'))
    assert.ok(second)
    assert.equal(second.reused, true)
    assert.equal(second.packet.id, first.packet.id)

    policy.setDefault({ jev: { enabled: 'once', reanalyzeOnCompaction: true } })
    push.invalidate()
    segment = 'compacted-2'
    const third = push.packetFor('s1', history('深夜写代码'))
    assert.ok(third)
    assert.equal(third.reused, false)
  } finally {
    ctx.close()
  }
})


test('Jev 段把选择结果注入 dynamic 上下文', async () => {
  const ctx = fixture()
  try {
    await ctx.store.add('detail:环境/深夜', {
      content: '深夜写代码',
      tag: '确信',
      introduction: '环境',
    })
    const summaries = new MemorySummaryStore({ root: ctx.root, store: ctx.store, generator: fakeGenerator })
    const selector = new HeuristicMemorySelector({ store: ctx.store, summaries })
    const policy = new MemoryPolicyStore(ctx.root)
    policy.setDefault({ mode: 'jev-push', jev: { enabled: 'once' } })
    const push = new MemoryPushService({ selector, policy, segmentKeyFor: () => 'initial' })
    const rendered = renderContext({
      sections: [memoryPushSection('jev-memory', push)],
      history: history('深夜写代码'),
      profile: { dataRoot: ctx.root, timeZone: 'Asia/Shanghai', principals: {} },
      sessionId: 's1',
      turn: 1,
      now: new Date('2026-11-07T12:00:00.000Z'),
    })
    assert.equal(rendered.system, '')
    assert.match(JSON.stringify(rendered.messages), /框架推送的记忆/)
  } finally {
    ctx.close()
  }
})


test('没有模型摘要时，选择器仍按正文选择', async () => {
  const ctx = fixture()
  try {
    await ctx.store.add('detail:环境/深夜', {
      content: '喜欢在深夜写代码',
      tag: '确信',
      introduction: '环境',
    })
    const noSummary = new MemorySummaryStore({ root: ctx.root, store: ctx.store })
    const selector = new HeuristicMemorySelector({ store: ctx.store, summaries: noSummary })
    const packet = selector.select({
      sessionId: 's1',
      history: history('深夜写代码'),
      policy: ctx.policy,
    })
    assert.ok(packet)
    assert.equal(packet.entries[0]?.summary, '')
    assert.match(packet.entries[0]?.content ?? '', /深夜写代码/)
  } finally {
    ctx.close()
  }
})
