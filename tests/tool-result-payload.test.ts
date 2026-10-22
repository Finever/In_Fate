import assert from 'node:assert/strict'
import test from 'node:test'
import { toolResultPayload } from '../src/tools/result-payload.ts'

test('tool.result 载荷保留取回所需字段', () => {
  const payload = toolResultPayload('call-1', {
    text: 'preview',
    structured: { code: 0 },
    bytes: 1234,
    encoding: 'gbk',
    requestedEncoding: 'utf-8',
    mime: 'text/plain',
    ref: 'spill:0123456789abcdef0123456789abcdef01234567',
    isError: false,
  })

  assert.deepEqual(payload, {
    callId: 'call-1',
    text: 'preview',
    isError: false,
    structured: { code: 0 },
    mime: 'text/plain',
    ref: 'spill:0123456789abcdef0123456789abcdef01234567',
    bytes: 1234,
    encoding: 'gbk',
    requestedEncoding: 'utf-8',
  })
})

test('没给的字段不塞空值', () => {
  assert.deepEqual(toolResultPayload('c', { text: 'x' }), {
    callId: 'c',
    text: 'x',
    isError: false,
  })
})
