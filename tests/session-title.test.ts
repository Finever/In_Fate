import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listSessions, sessionTitle } from '../src/app/session.ts'
import { EventStore } from '../src/core/store.ts'

function storeFor(file: string): EventStore {
  const store = new EventStore(file)
  store.append({
    stream: 'session:s',
    actor: 'system',
    type: 'session.created',
    payload: { sessionId: 's', formatVersion: 2, createdBy: 'user' },
  })
  return store
}

function appendUser(store: EventStore, text: string): void {
  store.append({
    stream: 'session:s',
    actor: 'user',
    type: 'message.user',
    payload: { text },
  })
  store.flush()
}

test('sessionTitle 取首条用户消息并压成一行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-title-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 's.jsonl')
    const store = storeFor(file)
    appendUser(store, '  第一行\n\n第二行\t还有空格  ')
    assert.equal(sessionTitle(file), '第一行 第二行 还有空格')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('sessionTitle 截断到 80 个字符，不切断代理对', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-title-long-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 's.jsonl')
    const store = storeFor(file)
    appendUser(store, '😀'.repeat(100))
    const title = sessionTitle(file)
    assert.equal(Array.from(title ?? '').length, 80)
    assert.equal(title, '😀'.repeat(80))
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('新建未发言的会话没有 title', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-title-empty-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 's.jsonl')
    storeFor(file).flush()
    assert.equal(sessionTitle(file), undefined)
    assert.equal(listSessions(dir, { withTitle: true })[0]?.title, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('文件变化后标题缓存失效，第一句话补上能读出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-title-cache-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 's.jsonl')
    const store = storeFor(file)
    store.flush()
    assert.equal(listSessions(dir, { withTitle: true })[0]?.title, undefined)

    appendUser(store, '后来才说的话')
    assert.equal(listSessions(dir, { withTitle: true })[0]?.title, '后来才说的话')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('首条用户消息在大段前缀之后时会扩大头部窗口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-title-expand-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 's.jsonl')
    const store = storeFor(file)
    store.append({
      stream: 'session:s',
      actor: 'system',
      type: 'message.system',
      payload: { text: 'x'.repeat(70 * 1024) },
    })
    appendUser(store, '大段前缀后的标题')
    assert.equal(sessionTitle(file), '大段前缀后的标题')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('不传 withTitle 时列表不做头部扫描', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-title-off-'))
  try {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const file = join(dir, 'sessions', 's.jsonl')
    const store = storeFor(file)
    appendUser(store, '不该出现')
    const session = listSessions(dir)[0]
    assert.ok(session)
    assert.equal('title' in session, false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
