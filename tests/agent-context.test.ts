import assert from 'node:assert/strict'
import test from 'node:test'
import { trimHistoryForContext } from '../src/agents/context.ts'
import { TokenEstimator } from '../src/compaction/estimate.ts'
import type { HistoryMessage } from '../src/projections/history.ts'

function toolMessage(id: string, text: string): HistoryMessage {
  return { role: 'tool', toolUseId: id, content: text }
}

test('上下文超限时从最旧工具结果开始裁，最新保留', () => {
  const estimator = new TokenEstimator(1)
  const messages: HistoryMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: '问题' }],
    },
    toolMessage('a', 'a'.repeat(1000)),
    toolMessage('b', 'b'.repeat(1000)),
    toolMessage('c', 'c'.repeat(1000)),
  ]

  const result = trimHistoryForContext(messages, '', [], 2500, estimator)
  assert.equal(result.over, false)
  assert.ok(result.trimmed > 0)
  assert.match((result.messages[1] as { content: string }).content, /omitted/)
  assert.equal((result.messages[3] as { content: string }).content, 'c'.repeat(1000))
})

test('未超限不改', () => {
  const estimator = new TokenEstimator(1)
  const messages: HistoryMessage[] = [toolMessage('a', 'short')]
  const result = trimHistoryForContext(messages, '', [], 1000, estimator)
  assert.equal(result.trimmed, 0)
  assert.equal(result.messages[0], messages[0])
})
