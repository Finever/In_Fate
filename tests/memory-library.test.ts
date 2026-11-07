import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryLibrary } from '../src/memory/library.ts'
import { MemoryPolicyStore } from '../src/memory/policy.ts'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { MemoryStore } from '../src/memory/store.ts'

function fixture(): {
  root: string
  store: MemoryStore
  library: MemoryLibrary
  close: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'if-memory-library-'))
  ensureMemoryLayout(root)
  const store = new MemoryStore(root, {
    now: () => new Date('2026-11-08T04:00:00.000Z'),
  })
  const library = new MemoryLibrary({ root, store })
  return {
    root,
    store,
    library,
    close: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

test('嵌套目录：可寻址、默认不进共享检索、UI 可列私域', async () => {
  const ctx = fixture()
  try {
    await ctx.store.add('detail:_未凉/us/时间线', {
      content: '深夜的约定',
      tag: '确信',
      introduction: '测试',
    })
    const doc = ctx.store.read('detail:_未凉/us/时间线')
    assert.equal(doc.filename, '时间线')

    assert.equal(ctx.store.listDocuments().some(item => item.private), false)
    assert.equal(ctx.store.search('深夜').length, 0)
    const privateDocs = ctx.store.listDocuments({ includePrivate: true })
    assert.equal(privateDocs.some(item => item.target === 'detail:_未凉/us/时间线'), true)
    assert.equal(ctx.store.search('深夜', 20, { includePrivate: true }).length, 1)
  } finally {
    ctx.close()
  }
})

test('MemoryStore 拒绝保护路径和 symlink', async () => {
  const ctx = fixture()
  try {
    assert.throws(() => ctx.store.target('detail:.git/config'), /unsafe|protected/)
    assert.throws(() => ctx.store.target('detail:_trash/old'), /unsafe|protected/)
    assert.throws(() => ctx.store.target('detail:test/../other'), /unsafe/)
  } finally {
    ctx.close()
  }
})

test('坏文件和 filename 不一致可被库树列出并修复', async () => {
  const ctx = fixture()
  try {
    const domain = join(ctx.root, 'detail', 'test')
    mkdirSync(domain, { recursive: true })
    writeFileSync(join(domain, 'broken.json'), '{ bad json', 'utf8')
    writeFileSync(join(domain, 'mismatch.json'), JSON.stringify({
      project: 'test',
      filename: 'other',
      introduction: '',
      entries: [],
    }), 'utf8')

    const all = ctx.store.listDocuments({ includeInvalid: true })
    assert.equal(all.find(item => item.target === 'detail:test/broken')?.invalid !== undefined, true)
    assert.equal(all.find(item => item.target === 'detail:test/mismatch')?.invalid !== undefined, true)
    assert.equal(ctx.store.listDocuments().some(item => item.target === 'detail:test/mismatch'), false)

    const file = ctx.library.read('detail/test/broken.json')
    assert.equal(file.invalid !== undefined, true)
    assert.equal(file.text, '{ bad json')
  } finally {
    ctx.close()
  }
})

test('保存 detail 保留未知顶层字段', async () => {
  const ctx = fixture()
  try {
    const target = 'detail:test/extra'
    const original = {
      project: 'test',
      filename: 'extra',
      introduction: '额外字段',
      custom: { keep: true },
      entries: [],
    }
    const domain = join(ctx.root, 'detail', 'test')
    mkdirSync(domain, { recursive: true })
    writeFileSync(join(domain, 'extra.json'), `${JSON.stringify(original, null, 2)}\n`, 'utf8')
    const doc = ctx.store.read(target)
    assert.deepEqual(doc.custom, { keep: true })
    await ctx.store.saveDocument(target, doc)
    const saved = JSON.parse(readFileSync(join(domain, 'extra.json'), 'utf8'))
    assert.deepEqual(saved.custom, { keep: true })
  } finally {
    ctx.close()
  }
})

test('MemoryLibrary：树、新建、移动、改名、回收站恢复', async () => {
  const ctx = fixture()
  try {
    await ctx.library.mkdir('detail/项目')
    await ctx.library.write('detail/项目/草稿.json', `${JSON.stringify({
      project: '项目',
      filename: '草稿',
      introduction: '草稿',
      entries: [],
    }, null, 2)}\n`)

    const tree = ctx.library.tree()
    assert.equal(tree.some(node => node.path === 'detail/项目' && node.kind === 'directory'), true)
    const file = ctx.library.read('detail/项目/草稿.json')
    assert.equal(file.document?.filename, '草稿')

    const proposalPath = join(ctx.root, 'proposals', 'pending.json')
    writeFileSync(proposalPath, JSON.stringify({
      kind: 'detail',
      proposalId: 'pending',
      target: 'detail:项目/草稿',
      sourceSession: 'test',
      status: 'pending',
      createdAt: '2026-11-08T00:00:00.000Z',
    }), 'utf8')

    await ctx.library.move('detail/项目/草稿.json', 'detail/项目/成稿.json')
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as { target: string }
    assert.equal(proposal.target, 'detail:项目/成稿')
    const moved = ctx.library.read('detail/项目/成稿.json')
    assert.equal(moved.document?.filename, '成稿')
    assert.throws(() => ctx.library.read('detail/项目/草稿.json'), /not found|ENOENT/)

    await ctx.library.remove('detail/项目/成稿.json')
    const trash = ctx.library.trash()
    assert.equal(trash.length, 1)
    await ctx.library.restore(trash[0]!.id)
    assert.equal(ctx.library.read('detail/项目/成稿.json').document?.filename, '成稿')
  } finally {
    ctx.close()
  }
})

test('MemoryLibrary 拒绝 log/.state 与跨域移动', async () => {
  const ctx = fixture()
  try {
    assert.throws(() => ctx.library.read('log/2026/01/01/x.jsonl'), /read-only|system/)
    assert.throws(() => ctx.library.read('.state/search.sqlite'), /invalid|read-only|system/)
    await assert.rejects(
      ctx.library.move('detail/a.json', 'summaries/a.json'),
      /between memory areas/,
    )
  } finally {
    ctx.close()
  }
})

test('policy.json 通过库写入后校验并重载', async () => {
  const ctx = fixture()
  try {
    const policy = new MemoryPolicyStore(ctx.root)
    const library = new MemoryLibrary({
      root: ctx.root,
      store: ctx.store,
      validateWrite: (path, text) => {
        if (path === 'policy.json') policy.validateText(text)
      },
      afterWrite: path => {
        if (path === 'policy.json') policy.reload()
      },
    })
    const text = `${JSON.stringify({
      version: 1,
      default: { mode: 'off' },
      agents: {},
      sessions: {},
    }, null, 2)}\n`
    await library.write('policy.json', text)
    assert.equal(policy.resolve('').mode, 'off')

    await assert.rejects(
      library.write('policy.json', '{"version":2}\n'),
      /unsupported policy version/,
    )
  } finally {
    ctx.close()
  }
})
