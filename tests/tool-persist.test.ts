import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { recordToolResultOnce, toolCallIdsWithResults } from '../src/tools/persist.ts'

test('同一个 toolCallId 只落一条结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-tool-persist-'))
  try {
    const store = new EventStore(join(dir, 'session.jsonl'))
    store.append({ stream: 'session:s', actor: 'system', type: 'session.created', payload: {} })
    const seen = toolCallIdsWithResults(store.read())
    const append = (event: Parameters<EventStore['append']>[0]) => store.append(event)

    const first = recordToolResultOnce({
      append,
      stream: 'session:s',
      callId: 'call-1',
      result: { text: 'ok' },
      seen,
    })
    const second = recordToolResultOnce({
      append,
      stream: 'session:s',
      callId: 'call-1',
      result: { text: 'again' },
      seen,
    })

    assert.ok(first)
    assert.equal(second, undefined)
    assert.equal(store.read().filter(event => event.type === 'tool.result').length, 1)
    assert.deepEqual([...toolCallIdsWithResults(store.read())], ['call-1'])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('append 失败时不把 id 记成已答', () => {
  const seen = new Set<string>()
  assert.throws(() => recordToolResultOnce({
    append: () => { throw new Error('disk full') },
    stream: 'session:s',
    callId: 'call-2',
    result: { text: 'ok' },
    seen,
  }))
  assert.equal(seen.has('call-2'), false)
})
