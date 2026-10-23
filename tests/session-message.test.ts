import assert from 'node:assert/strict'
import test from 'node:test'
import { projectHistory } from '../src/projections/history.ts'

test('session.message 投影成跨会话系统消息，不混成 assistant', () => {
  const messages = projectHistory([
    {
      v: 1,
      id: 'e1',
      ts: '2026-10-24T00:00:00.000Z',
      stream: 'session:s2',
      actor: 'system',
      type: 'session.created',
      payload: { sessionId: 's2', createdBy: 'user' },
    },
    {
      v: 1,
      id: 'e2',
      ts: '2026-10-24T00:00:01.000Z',
      stream: 'session:s2',
      actor: 'system',
      type: 'session.message',
      refs: { fromSession: 's1', link: 'l1' },
      payload: {
        messageId: 'm1',
        fromSession: 's1',
        linkId: 'l1',
        kind: 'question',
        text: '你卡在哪一步？',
        hop: 1,
      },
    },
  ], { timeTag: false })

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, 'system')
  const text = JSON.stringify(messages[0])
  assert.match(text, /跨会话消息/)
  assert.match(text, /from=s1/)
  assert.match(text, /kind=question/)
  assert.match(text, /你卡在哪一步/)
  assert.equal(messages.some(message => message.role === 'assistant'), false)
})
