import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAccess } from '../src/memory/access.ts'
import { MemoryPolicyStore } from '../src/memory/policy.ts'
import { MemoryProposalStore } from '../src/memory/proposals.ts'
import { ensureMemoryLayout } from '../src/memory/root.ts'
import { MemorySearchIndex } from '../src/memory/search-index.ts'
import { MemorySpaceAccess } from '../src/memory/space-access.ts'
import {
  agentPrincipal,
  MemorySpaceStore,
  validateMemorySpace,
  type MemorySpace,
} from '../src/memory/space.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { createMemoryTools } from '../src/memory/tools.ts'

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function now(): Date {
  return new Date('2026-11-22T10:00:00.000Z')
}

function privateSpace(id: string, owner = 'main'): MemorySpace {
  const at = now().toISOString()
  return {
    id,
    name: id,
    kind: 'private',
    owner: agentPrincipal(owner),
    members: [],
    autoPush: false,
    createdAt: at,
    updatedAt: at,
  }
}

function sharedSpace(id: string, members: MemorySpace['members']): MemorySpace {
  const at = now().toISOString()
  return {
    id,
    name: id,
    kind: 'shared',
    owner: 'user',
    members,
    autoPush: true,
    createdAt: at,
    updatedAt: at,
  }
}

test('记忆空间注册表：私域只归 owner，共有按成员', async () => {
  const dir = tempRoot('if-space-store-')
  try {
    const store = new MemorySpaceStore(dir, { now })
    await store.upsert(privateSpace('weiliang', 'main'))
    await store.upsert(sharedSpace('project-x', [
      { principal: agentPrincipal('main'), role: 'write' },
      { principal: agentPrincipal('helper'), role: 'read' },
    ]))

    assert.deepEqual(store.forAgent('main').map(space => space.id).sort(), ['project-x', 'weiliang'])
    assert.deepEqual(store.forAgent('helper').map(space => space.id), ['project-x'])
    assert.deepEqual(store.forAgent('other').map(space => space.id), [])
    assert.equal(store.roleForAgent('main', 'weiliang'), 'write')
    assert.equal(store.roleForAgent('helper', 'weiliang'), undefined)
    assert.equal(store.roleForAgent('helper', 'project-x'), 'read')

    const reloaded = new MemorySpaceStore(dir)
    assert.deepEqual(reloaded.list().map(space => space.id).sort(), ['project-x', 'weiliang'])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('记忆空间校验：私域 owner 必须是 agent、成员不重复', () => {
  assert.throws(
    () => validateMemorySpace({ ...privateSpace('x'), owner: 'user' }),
    /private memory space owner/,
  )
  assert.throws(
    () => validateMemorySpace({
      ...sharedSpace('s', [
        { principal: agentPrincipal('a'), role: 'read' },
        { principal: agentPrincipal('a'), role: 'write' },
      ]),
    }),
    /duplicate memory space member/,
  )
  assert.throws(() => validateMemorySpace({ ...privateSpace('bad/id') }), /invalid memory space id/)
  assert.throws(
    () => validateMemorySpace({
      ...sharedSpace('s', [{ principal: 'nobody', role: 'read' }]),
    }),
    /invalid memory space member principal/,
  )
})

test('衍生 agent 只继承 shared 成员，私域不继承，可关闭', async () => {
  const dir = tempRoot('if-space-inherit-')
  try {
    const store = new MemorySpaceStore(dir, { now })
    await store.upsert(sharedSpace('project-x', [
      { principal: agentPrincipal('parent'), role: 'write' },
    ]))
    await store.upsert(privateSpace('private-parent', 'parent'))

    const inherited = await store.inheritShared('parent', 'child')
    assert.equal(inherited, 1)
    const shared = store.get('project-x')
    assert.equal(
      shared?.members.find(member => member.principal === agentPrincipal('child'))?.inheritedFrom,
      'parent',
    )
    assert.equal(store.get('private-parent')?.members.some(
      member => member.principal === agentPrincipal('child'),
    ), false)

    const off = await store.inheritShared('parent', 'child-off', { enabled: false })
    assert.equal(off, 0)
    assert.equal(
      store.get('project-x')?.members.some(
        member => member.principal === agentPrincipal('child-off'),
      ),
      false,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('旧 _ 目录迁移成 user 私域，幂等', async () => {
  const dir = tempRoot('if-space-migrate-')
  try {
    const detail = join(dir, 'detail')
    mkdirSync(join(detail, '_weiliang'), { recursive: true })
    mkdirSync(join(detail, '_legacy'), { recursive: true })
    mkdirSync(join(detail, 'shared-domain'), { recursive: true })
    const store = new MemorySpaceStore(dir, { now })
    const count = await store.migratePrivateDirs(detail)
    assert.equal(count, 2)
    assert.deepEqual(
      store.list().map(space => `${space.kind}:${space.dir}`).sort(),
      ['user:_legacy', 'user:_weiliang'],
    )
    const again = await store.migratePrivateDirs(detail)
    assert.equal(again, 0)
    assert.equal(store.list().length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('记忆空间工具：space 参数走 ACL，检索按空间过滤', async () => {
  const dir = tempRoot('if-space-tools-')
  let index: MemorySearchIndex | undefined
  try {
    const root = join(dir, 'memory')
    ensureMemoryLayout(root)
    const store = new MemoryStore(root)
    const policy = new MemoryPolicyStore(root, { agentIdFor: () => 'main' })
    const access = new MemoryAccess(join(dir, 'grants.json'), sessionId => ({
      createdBy: sessionId.startsWith('helper') ? 'agent:helper' : 'user',
      kind: sessionId.startsWith('helper') ? 'agent' : 'user',
    }))
    const proposals = new MemoryProposalStore(root)
    index = new MemorySearchIndex(root, store)
    const spaces = new MemorySpaceStore(root, { now })
    await spaces.upsert(privateSpace('weiliang', 'main'))
    await spaces.upsert(sharedSpace('project-x', [
      { principal: agentPrincipal('main'), role: 'write' },
      { principal: agentPrincipal('helper'), role: 'propose' },
    ]))
    const agentOf: Record<string, string> = {
      'main-steward': 'main',
      'helper-worker': 'helper',
    }
    const spaceAccess = new MemorySpaceAccess(spaces, access, id => agentOf[id])
    const tools = new Map(createMemoryTools({
      store,
      access,
      proposals,
      policy,
      searchIndex: index,
      spaces,
      spaceAccess,
    }).map(tool => [tool.name, tool]))
    const context = (sessionId: string) => ({
      sessionId,
      callId: 'call-1',
      cwd: dir,
      signal: new AbortController().signal,
    })

    await store.add('detail:环境/测试', {
      content: '共享关键词ALPHA',
      tag: '确信',
      introduction: '测试',
    })
    const added = await tools.get('memory_add')!.run({
      target: 'detail:notes/todo',
      content: '私域关键词BETA',
      tag: '确信',
      introduction: '测试',
      space: 'weiliang',
    }, context('main-steward'))
    assert.equal(added.isError, undefined)
    assert.match(added.text ?? '', /detail:_weiliang\/notes\/todo/)

    // owner 自己的私域读写：带 space 可以，不带 space 走共享工具仍挡。
    const readOwn = await tools.get('memory_read')!.run(
      { target: 'detail:notes/todo', space: 'weiliang' },
      context('main-steward'),
    )
    assert.equal(readOwn.isError, undefined)
    assert.match(readOwn.text ?? '', /私域关键词BETA/)
    const readOther = await tools.get('memory_read')!.run(
      { target: 'detail:notes/todo', space: 'weiliang' },
      context('helper-worker'),
    )
    assert.equal(readOther.isError, true)
    const readByName = await tools.get('memory_read')!.run(
      { target: 'detail:_weiliang/notes/todo' },
      context('main-steward'),
    )
    assert.equal(readByName.isError, true)

    // memory_spaces：owner 两个空间，helper 只看得见 project-x。
    const listed = await tools.get('memory_spaces')!.run({}, context('main-steward'))
    assert.match(listed.text ?? '', /weiliang/)
    assert.match(listed.text ?? '', /project-x/)
    const helperListed = await tools.get('memory_spaces')!.run({}, context('helper-worker'))
    assert.match(helperListed.text ?? '', /project-x/)
    assert.doesNotMatch(helperListed.text ?? '', /weiliang/)

    // 检索：不带 space 只回可读的；带 space 只看该空间。
    index.markDirty()
    const sharedSearch = await tools.get('memory_search')!.run(
      { query: '关键词' },
      context('helper-worker'),
    )
    assert.match(sharedSearch.text ?? '', /ALPHA/)
    assert.doesNotMatch(sharedSearch.text ?? '', /BETA/)
    const ownSearch = await tools.get('memory_search')!.run(
      { query: '关键词' },
      context('main-steward'),
    )
    assert.match(ownSearch.text ?? '', /BETA/)
    const scoped = await tools.get('memory_search')!.run(
      { query: '关键词', space: 'weiliang' },
      context('main-steward'),
    )
    assert.match(scoped.text ?? '', /BETA/)
    assert.doesNotMatch(scoped.text ?? '', /ALPHA/)
    const deniedSearch = await tools.get('memory_search')!.run(
      { query: '关键词', space: 'weiliang' },
      context('helper-worker'),
    )
    assert.equal(deniedSearch.isError, true)

    // 共有只给 propose 的成员：直写被拒，提议可以。
    const sharedWrite = await tools.get('memory_add')!.run({
      target: 'detail:环境/other',
      content: '直写应被拒',
      tag: '可信',
      introduction: '测试',
      space: 'project-x',
    }, context('helper-worker'))
    assert.equal(sharedWrite.isError, true)
    const proposed = await tools.get('memory_propose')!.run({
      target: 'detail:环境/other',
      content: '提议可以',
      tag: '可信',
      introduction: '测试',
      space: 'project-x',
    }, context('helper-worker'))
    assert.equal(proposed.isError, undefined)
    assert.match(proposed.text ?? '', /detail:project-x\/环境\/other/)
  } finally {
    index?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('空间 ACL：steward 满权、worker 降级、私域只认 owner', async () => {
  const dir = tempRoot('if-space-acl-')
  try {
    const store = new MemorySpaceStore(dir, { now })
    await store.upsert(privateSpace('weiliang', 'main'))
    await store.upsert(sharedSpace('project-x', [
      { principal: agentPrincipal('main'), role: 'write' },
      { principal: agentPrincipal('helper'), role: 'read' },
    ]))

    const grantsFile = join(dir, 'memory-grants.json')
    const access = new MemoryAccess(grantsFile, () => undefined)
    access.grant('main-steward', 'steward')
    access.grant('main-worker', 'worker')
    access.grant('main-observer', 'observer')
    access.grant('helper-worker', 'worker')
    access.grant('other-steward', 'steward')

    const agentOf: Record<string, string> = {
      'main-steward': 'main',
      'main-worker': 'main',
      'main-observer': 'main',
      'helper-worker': 'helper',
      'other-steward': 'other',
    }
    const spaceAccess = new MemorySpaceAccess(store, access, id => agentOf[id])

    assert.equal(spaceAccess.can('main-steward', 'weiliang', 'write'), true)
    assert.equal(spaceAccess.can('main-worker', 'weiliang', 'write'), false)
    assert.equal(spaceAccess.can('main-worker', 'weiliang', 'propose'), true)
    assert.equal(spaceAccess.can('main-worker', 'weiliang', 'read'), true)
    assert.equal(spaceAccess.can('main-observer', 'weiliang', 'propose'), false)
    assert.equal(spaceAccess.can('other-steward', 'weiliang', 'read'), false)

    assert.equal(spaceAccess.can('helper-worker', 'project-x', 'read'), true)
    assert.equal(spaceAccess.can('helper-worker', 'project-x', 'write'), false)
    assert.equal(spaceAccess.can('other-steward', 'project-x', 'read'), false)

    assert.equal(spaceAccess.canAutoPush('main-steward', 'weiliang'), false)
    assert.equal(spaceAccess.canAutoPush('main-worker', 'weiliang'), false)
    assert.equal(spaceAccess.canAutoPush('main-steward', 'project-x'), true)
    assert.equal(spaceAccess.canAutoPush('helper-worker', 'project-x'), true)

    const described = spaceAccess.describe('main-steward')
    assert.deepEqual(described.map(space => `${space.id}:${space.role}`).sort(), [
      'project-x:write',
      'weiliang:write',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
