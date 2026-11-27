import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import type { SessionWriter } from '../src/core/session-writer.ts'
import type { MemoryLogService } from '../src/memory/internal-log.ts'
import { localLogStamp, logPathForDay, readLog } from '../src/memory/log.ts'

function configFor(dataRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user', name: '用户' }, agents: [{ id: 'main', name: '助手' }] },
    },
    providers: [],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
}

test('记忆库默认落在 data/memory，并建好新布局', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-root-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const container = new Container()
  const app = buildBundle(configFor(dataRoot), container)
  try {
    for (const name of ['detail', 'log', 'proposals', 'summaries', 'agents', '.state', 'meta.json']) {
      assert.equal(existsSync(join(dataRoot, 'memory', name)), true, name)
    }
  } finally {
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('会话事件经 bundle 自动写内部 log，不靠 hook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-log-wire-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const container = new Container()
  const app = buildBundle(configFor(dataRoot), container)
  try {
    const sessionId = app.createSession({ materialize: true })
    const writer = container.get<(id: string) => SessionWriter>('sessionWriter')(sessionId)
    const stream = `session:${sessionId}`
    writer.append({ stream, actor: 'user', type: 'message.user', payload: { text: '接入测试' } })
    writer.append({
      stream,
      actor: 'agent',
      type: 'message.assistant',
      payload: { text: '收到' },
    })
    writer.append({ stream, actor: 'system', type: 'turn.completed', payload: { status: 'completed' } })
    await container.get<MemoryLogService>('memoryLog').flush()

    const stamp = localLogStamp(new Date(), 'Asia/Shanghai')
    const path = logPathForDay(join(dataRoot, 'memory'), stamp, sessionId)
    const rows = readLog(path)
    assert.equal(rows[0]?._meta, 1)
    assert.equal(rows[0]?.agent_name, '助手')
    assert.equal(rows[1]?.who, '用户')
    assert.equal(rows[1]?.text, '接入测试')
    assert.equal(rows[2]?.type, 'turn-start')
    assert.equal(rows[3]?.p, '收到')
    assert.equal(rows[4]?.type, 'turn-end')
  } finally {
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('memory.enabled=false 不建记忆库；旧 memoryLogRoot 仍兼容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-root-legacy-'))
  const dataRoot = join(dir, 'data')
  const legacyRoot = join(dir, 'external-memory')
  mkdirSync(dataRoot, { recursive: true })

  const disabled = configFor(dataRoot)
  const disabledApp = buildBundle({
    ...disabled,
    profile: { ...disabled.profile, memory: { enabled: false } },
  }, new Container())
  try {
    assert.equal(existsSync(join(dataRoot, 'memory')), false)
  } finally {
    await disabledApp.dispose()
  }

  const legacy = configFor(dataRoot)
  const legacyApp = buildBundle({
    ...legacy,
    profile: { ...legacy.profile, memoryRoot: undefined, memoryLogRoot: legacyRoot },
  }, new Container())
  try {
    assert.equal(existsSync(join(legacyRoot, 'detail')), true)
  } finally {
    await legacyApp.dispose()
  }

  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
