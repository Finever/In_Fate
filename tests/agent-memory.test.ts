import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AgentManifestStore,
  defaultAgentManifest,
  validateAgentManifest,
} from '../src/memory/agent-manifest.ts'
import { AgentIdentityStore } from '../src/memory/identity-slots.ts'
import { loadIdentitySources, readSources } from '../src/memory/sources.ts'
import {
  applyIdentityMigration,
  planIdentityMigration,
} from '../src/memory/migrate-identity.ts'

function workspace(): { dir: string; agentDir: string; memoryRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'if-agent-memory-'))
  const agentDir = join(dir, 'agent')
  const memoryRoot = join(dir, 'memory')
  mkdirSync(join(agentDir, 'memory'), { recursive: true })
  mkdirSync(memoryRoot, { recursive: true })
  return { dir, agentDir, memoryRoot }
}

function seedLegacy(agentDir: string): void {
  writeFileSync(
    join(agentDir, 'SOUL.md'),
    '# SOUL\n\n## 我叫什么\n\n旧名字\n\n## 这个凉字\n\n冷。\n',
    'utf8',
  )
  writeFileSync(join(agentDir, 'USER.md'), '# USER\n\n## 他是谁\n\n他。\n', 'utf8')
  writeFileSync(join(agentDir, 'memory', 'FACT.md'), '# FACT\n\n## 提示\n\n事。\n', 'utf8')
}

test('agent manifest 可读写，槽位顺序稳定', async () => {
  const { dir, memoryRoot } = workspace()
  try {
    const store = new AgentManifestStore(memoryRoot)
    const manifest = defaultAgentManifest('main', 'Demo Agent', {
      principle: '本心',
      preference: '所爱',
      prompt: '提示',
    })
    await store.write(manifest)

    const read = store.read('main')
    assert.equal(read?.name, 'Demo Agent')
    assert.deepEqual(read?.identity.map(slot => slot.id), ['principle', 'preference', 'prompt'])
    assert.deepEqual(read?.identity.map(slot => slot.label), ['本心', '所爱', '提示'])
    assert.equal(store.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})


test('createDefault 建主 agent 的 PPP 文件，writeSlot 先备份再整文件写入', async () => {
  const { dir, memoryRoot } = workspace()
  try {
    const store = new AgentManifestStore(memoryRoot)
    const manifest = await store.createDefault('demo-agent', 'Demo Agent')
    assert.equal(manifest.name, 'Demo Agent')
    assert.equal(store.list().length, 1)
    for (const slot of manifest.identity) {
      assert.equal(existsSync(join(memoryRoot, 'agents', 'demo-agent', 'identity', slot.file)), true)
    }

    const identity = new AgentIdentityStore(memoryRoot, 'demo-agent', { manifest })
    assert.match(identity.readOrEmpty('principle'), /# 原则/)
    assert.match(identity.readOrEmpty('principle'), /原则。这里告诉我我是谁/)
    assert.doesNotMatch(identity.readOrEmpty('principle'), /写完删掉/)
    assert.match(identity.readOrEmpty('prompt'), /## IF 环境/)
    assert.match(identity.readOrEmpty('prompt'), /## 记忆系统/)
    const result = await identity.writeSlot('principle', '# 原则\n\n## 正文\n\n新的。\n')
    assert.equal(existsSync(result.backup), true)
    assert.match(identity.read('principle'), /新的。/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('manifest 拒绝越界文件和重复槽位', async () => {
  const { dir, memoryRoot } = workspace()
  try {
    assert.throws(() => validateAgentManifest({
      version: 1,
      id: 'main',
      name: 'x',
      identity: [{ id: 'principle', label: 'x', file: '../x.md', order: 1 }],
    }), /unsafe identity file/)

    assert.throws(() => validateAgentManifest({
      version: 1,
      id: 'main',
      name: 'x',
      identity: [
        { id: 'principle', label: 'x', file: 'a.md', order: 1 },
        { id: 'principle', label: 'y', file: 'b.md', order: 2 },
      ],
    }), /duplicate identity slot id/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('无 manifest 时回退旧 SOUL/USER/FACT 路径', () => {
  const { dir, agentDir, memoryRoot } = workspace()
  try {
    seedLegacy(agentDir)
    const sources = loadIdentitySources(agentDir, memoryRoot, 'main')
    assert.deepEqual(sources.map(source => source.id), ['identity', 'user', 'fact'])
    assert.equal(sources[0]?.path, join(agentDir, 'SOUL.md'))
    assert.equal(readSources(sources).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('迁移 dry-run 不写文件；apply 写 manifest 和槽位副本，旧文件不动', async () => {
  const { dir, agentDir, memoryRoot } = workspace()
  try {
    seedLegacy(agentDir)
    const legacySoul = readFileSync(join(agentDir, 'SOUL.md'), 'utf8')

    const plan = planIdentityMigration({
      agentDir,
      memoryRoot,
      agentId: 'main',
      name: 'Demo Agent',
      labels: { principle: '本心', preference: '所爱', prompt: '提示' },
    })
    assert.equal(plan.files.length, 3)
    assert.deepEqual(plan.manifest.identity.map(slot => slot.label), ['本心', '所爱', '提示'])
    assert.equal(existsSync(join(memoryRoot, 'agents', 'main', 'agent.json')), false)

    const result = await applyIdentityMigration(plan)
    assert.equal(result.written.length, 3)
    assert.equal(existsSync(join(memoryRoot, 'agents', 'main', 'agent.json')), true)
    assert.equal(
      readFileSync(join(memoryRoot, 'agents', 'main', 'identity', 'principle.md'), 'utf8'),
      legacySoul,
    )
    assert.equal(readFileSync(join(agentDir, 'SOUL.md'), 'utf8'), legacySoul)

    const sources = loadIdentitySources(agentDir, memoryRoot, 'main')
    assert.deepEqual(sources.map(source => source.id), ['principle', 'preference', 'prompt'])
    assert.equal(readSources(sources).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('目标文件冲突时默认拒绝，force 才备份覆盖', async () => {
  const { dir, agentDir, memoryRoot } = workspace()
  try {
    seedLegacy(agentDir)
    const target = join(memoryRoot, 'agents', 'main', 'identity', 'principle.md')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, '# 别的\n', 'utf8')

    const plan = planIdentityMigration({ agentDir, memoryRoot, agentId: 'main' })
    assert.equal(plan.files.find(file => file.slot === 'principle')?.conflict, true)
    await assert.rejects(() => applyIdentityMigration(plan), /identity target conflict/)

    const result = await applyIdentityMigration(plan, { force: true })
    assert.equal(result.backups.length, 1)
    assert.match(readFileSync(target, 'utf8'), /## 我叫什么/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('AgentIdentityStore 只替换指定二级标题并留备份', async () => {
  const { dir, agentDir, memoryRoot } = workspace()
  try {
    seedLegacy(agentDir)
    const plan = planIdentityMigration({ agentDir, memoryRoot, agentId: 'main' })
    await applyIdentityMigration(plan)

    const store = new AgentIdentityStore(memoryRoot, 'main')
    const before = store.read('principle')
    const preview = store.preview({
      slot: 'principle',
      section: '我叫什么',
      content: '新名字。',
    })
    assert.match(preview.before, /旧名字/)
    assert.match(preview.after, /新名字/)
    assert.doesNotMatch(preview.after, /旧名字/)

    const result = await store.apply({
      slot: 'principle',
      section: '我叫什么',
      content: '新名字。',
    })
    assert.equal(existsSync(result.backup), true)
    assert.match(store.read('principle'), /新名字/)
    assert.doesNotMatch(store.read('principle'), /旧名字/)
    assert.equal(before.includes('旧名字'), true)
    assert.equal(readFileSync(join(agentDir, 'SOUL.md'), 'utf8').includes('旧名字'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('identity proposal 通过适配器落到 manifest 槽位', async () => {
  const { dir, agentDir, memoryRoot } = workspace()
  try {
    seedLegacy(agentDir)
    await applyIdentityMigration(planIdentityMigration({ agentDir, memoryRoot, agentId: 'main' }))

    const { MemoryProposalStore } = await import('../src/memory/proposals.ts')
    const { MemoryStore } = await import('../src/memory/store.ts')
    const { ManifestIdentityStore } = await import('../src/memory/identity-adapter.ts')

    const proposals = new MemoryProposalStore(memoryRoot)
    const proposal = proposals.proposeIdentity({
      target: 'identity:SOUL',
      sourceSession: 'session-test',
      identity: {
        file: 'SOUL',
        section: '我叫什么',
        content: '适配器名字。',
      },
    })
    const adapter = new ManifestIdentityStore(new AgentIdentityStore(memoryRoot, 'main'))
    await proposals.accept(proposal.proposalId, new MemoryStore(memoryRoot), adapter)

    assert.match(adapter.read('SOUL'), /适配器名字/)
    assert.match(
      readFileSync(join(memoryRoot, 'agents', 'main', 'identity', 'principle.md'), 'utf8'),
      /适配器名字/,
    )
    assert.match(readFileSync(join(agentDir, 'SOUL.md'), 'utf8'), /旧名字/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
