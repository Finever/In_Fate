import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { inspectEvents, previewEvent, tailSession } from '../src/app/inspect.ts'

test('tail 从尾部取、按 afterSeq 续读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-inspect-'))
  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    const append = (type: string, payload: Record<string, unknown> = {}): void => {
      store.append({ stream: 'session:s', actor: 'system', type, payload })
    }
    append('session.created', { createdBy: 'user' })
    for (let index = 0; index < 6; index += 1) append('message.user', { text: `m${index}` })

    const tail = tailSession('s', store.read(), { limit: 3 })
    assert.equal(tail.events.length, 3)
    assert.equal(tail.events.at(-1)?.preview, 'm5')
    assert.equal(tail.eof, true)

    const next = tailSession('s', store.read(), { afterSeq: tail.events[0]!.seq, limit: 2 })
    assert.equal(next.events.length, 2)
    assert.equal(next.events[0]?.preview, 'm4')
    assert.equal(next.eof, true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('inspect 识别 running、pending 工具与 agent 终态', () => {
  const store = new EventStore(join(mkdtempSync(join(tmpdir(), 'if-inspect-')), 'session.jsonl'))
  const add = (type: string, payload: Record<string, unknown> = {}): void => {
    store.append({ stream: 'session:s', actor: 'system', type, payload })
  }
  add('session.created', { createdBy: 'user' })
  add('message.user', { text: 'go' })
  add('tool.call', { callId: 'c1', call: 'read', args: { file_path: 'a' } })
  add('turn.completed', { steps: 1 })

  let info = inspectEvents('s', store.read())
  assert.equal(info.state, 'idle')
  assert.deepEqual(info.pendingToolCalls, [])

  add('message.user', { text: 'again' })
  add('tool.call', { callId: 'c2', call: 'bash', args: { command: 'ls' } })
  info = inspectEvents('s', store.read())
  assert.equal(info.state, 'running')
  assert.deepEqual(info.pendingToolCalls, [{ callId: 'c2', name: 'bash' }])
  assert.equal(info.lastType, 'tool.call')

  add('tool.result', { callId: 'c2', text: 'ok', isError: false })
  add('agent.completed', { summary: 'done' })
  info = inspectEvents('s', store.read())
  assert.equal(info.state, 'done')
  assert.deepEqual(info.pendingToolCalls, [])

  assert.match(previewEvent(store.read().find(event => event.type === 'tool.result')!), /^ok /)
  rmSync(join(store.file, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
