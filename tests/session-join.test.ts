import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { SessionWriter } from '../src/core/session-writer.ts'
import { SessionJoinScheduler } from '../src/session/joins.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function setup(): {
  dir: string
  scheduler: SessionJoinScheduler
  running: Set<string>
  wake: string[]
  storeFor: (id: string) => EventStore
  writerFor: (id: string) => SessionWriter
  close: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'if-join-'))
  const stores = new Map<string, EventStore>()
  const writers = new Map<string, SessionWriter>()
  const storeFor = (id: string): EventStore => {
    let store = stores.get(id)
    if (!store) {
      store = new EventStore(join(dir, `${id}.jsonl`))
      stores.set(id, store)
    }
    return store
  }
  const writerFor = (id: string): SessionWriter => {
    let writer = writers.get(id)
    if (!writer) {
      writer = SessionWriter.open(storeFor(id))
      writers.set(id, writer)
    }
    return writer
  }

  const running = new Set<string>()
  const wake: string[] = []
  const scheduler = new SessionJoinScheduler({
    storeFor,
    writerFor,
    isRunning: id => running.has(id),
    linked: () => true,
    wake: id => wake.push(id),
  })

  return {
    dir,
    scheduler,
    running,
    wake,
    storeFor,
    writerFor,
    close: () => {
      scheduler.dispose()
      for (const writer of writers.values()) writer.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

test('join all：目标都完成才唤醒', () => {
  const ctx = setup()
  try {
    ctx.running.add('a')
    ctx.running.add('b')
    const record = ctx.scheduler.create({ sessionId: 'w', targets: ['a', 'b'] })
    assert.equal(record.status, 'pending')
    assert.equal(ctx.wake.length, 0)

    ctx.scheduler.onTurnCompleted('a', 'completed')
    assert.equal(ctx.scheduler.pending('w').length, 1)
    assert.equal(ctx.wake.length, 0)

    ctx.scheduler.onTurnCompleted('b', 'completed')
    assert.equal(ctx.scheduler.pending('w').length, 0)
    assert.deepEqual(ctx.wake, ['w'])

    assert.deepEqual(ctx.scheduler.pending('w'), [])
  } finally {
    ctx.close()
  }
})

test('join any / 已空闲目标立即满足', () => {
  const ctx = setup()
  try {
    const record = ctx.scheduler.create({ sessionId: 'w', targets: ['a', 'b'], mode: 'any' })
    assert.equal(record.status, 'done')
    // 创建发生在当前 turn/调用方里，立即满足不再额外唤醒。
    assert.deepEqual(ctx.wake, [])
  } finally {
    ctx.close()
  }
})

test('join timeout 唤醒并落 timeout 事件', async () => {
  const ctx = setup()
  try {
    ctx.running.add('a')
    const record = ctx.scheduler.create({
      sessionId: 'w',
      targets: ['a'],
      timeoutMs: 20,
    })
    assert.equal(record.status, 'pending')
    await sleep(60)
    assert.equal(record.status, 'timeout')
    assert.deepEqual(ctx.wake, ['w'])
  } finally {
    ctx.close()
  }
})

test('restore 从事件流恢复未完成 join', () => {
  const ctx = setup()
  try {
    ctx.running.add('a')
    const record = ctx.scheduler.create({ sessionId: 'w', targets: ['a'] })
    // 用一个新调度器模拟重启
    const rebuilt = new SessionJoinScheduler({
      storeFor: ctx.storeFor,
      writerFor: ctx.writerFor,
      isRunning: id => ctx.running.has(id),
      linked: () => true,
      wake: id => ctx.wake.push(id),
    })
    rebuilt.restore('w')
    const restored = rebuilt.pending('w')[0]
    assert.equal(rebuilt.pending('w').length, 1)
    rebuilt.onTurnCompleted('a', 'completed')
    assert.equal(rebuilt.pending('w').length, 0)
    assert.equal(restored?.status, 'done')
    rebuilt.dispose()
  } finally {
    ctx.close()
  }
})
