import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveCompactedSegments } from '../src/compaction/archive.ts'
import { EventStore } from '../src/core/store.ts'
import { projectHistory } from '../src/projections/history.ts'

test('压缩后归档旧段，投影仍从摘要开始', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-archive-proj-'))
  try {
    const store = new EventStore(join(dir, 'session.jsonl'), { segmentMaxBytes: 420 })
    const append = (type: string, payload: Record<string, unknown>, actor = 'agent') =>
      store.append({ stream: 'session:s', actor, type, payload })

    append('session.created', { formatVersion: 2 }, 'system')
    let firstUser = ''
    let lastAssistant = ''
    for (let index = 0; index < 10; index += 1) {
      const user = append('message.user', { text: `问题 ${index} ${'u'.repeat(30)}` }, 'user')
      if (index === 0) firstUser = user.id
      const assistant = append('message.assistant', { text: `回答 ${index} ${'a'.repeat(30)}` })
      if (index === 8) lastAssistant = assistant.id
      append('turn.completed', {
        steps: 1, usage: { input: 1, output: 1, cacheRead: 0 }, aborted: false, hitLimit: false,
      }, 'system')
    }

    append('context.compacted', {
      anchor: { stream: 'session:s', fromEventId: firstUser, toEventId: lastAssistant },
      summary: { goal: '旧目标', constraints: [], decisions: [], facts: [], failed: [], open: [] },
      stats: { tokensBefore: 1000, tokensAfter: 50, foldedCount: 30, prunedCount: 0 },
      trigger: 'auto',
      phase: 'turn-start',
      strategy: 'hybrid',
      turn: 10,
    }, 'system')

    const archived = archiveCompactedSegments(store)
    assert.ok(archived.length > 0)
    assert.ok(store.read().length < store.readAll().length)

    const messages = projectHistory(store.read(), { timeTag: false })
    assert.equal(messages[0]!.role, 'system')
    assert.match(JSON.stringify(messages[0]), /压缩摘要/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
