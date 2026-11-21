import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { chatModel, supportsAssistantPrefill } from '../src/model/chat-model.ts'
import type { ChatRequest } from '../src/model/chat.ts'
import { ModelRegistry, type ResolvedModel } from '../src/model/registry.ts'
import type { ModelEvent, ProviderConfig } from '../src/model/types.ts'
import { readSSE } from '../src/model/sse.ts'
import { apiUrl } from '../src/model/urls.ts'
import type { HistoryMessage } from '../src/projections/history.ts'

interface Captured {
  url?: string
  headers?: Record<string, string | string[] | undefined>
  body?: Record<string, unknown>
}

async function mockServer(
  handle: (body: Record<string, unknown>, captured: Captured) => { status?: number; body: string },
): Promise<{ baseUrl: string; captured: Captured; close: () => Promise<void> }> {
  const captured: Captured = {}
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      captured.url = req.url
      captured.headers = req.headers
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      captured.body = body
      const result = handle(body, captured)
      res.writeHead(result.status ?? 200, { 'content-type': 'text/event-stream' })
      res.end(result.body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function resolvedModel(
  family: string,
  baseUrl: string,
  patch: Partial<ProviderConfig> = {},
): ResolvedModel {
  const provider: ProviderConfig = {
    id: 'p',
    name: 'P',
    defaultChatEndpoint: family,
    endpoints: { [family]: { adapterFamily: family, baseUrl } },
    models: [{ id: 'm' }],
    ...patch,
  }
  return {
    provider,
    model: { id: 'm' },
    endpoint: provider.endpoints[family]!,
    apiModelId: 'm',
    family,
  }
}

function request(resolved: ResolvedModel, messages: readonly HistoryMessage[]): ChatRequest {
  return {
    resolved,
    system: 'you are a test',
    messages,
    tools: [{
      name: 'read',
      description: 'read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    retry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
  }
}

async function collect(stream: AsyncGenerator<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

const messages: HistoryMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_0', name: 'read', input: { path: 'x' } }],
  },
  { role: 'tool', toolUseId: 'call_0', content: 'ok' },
]

test('resolveApiKeys：跳过停用、去重、兼容旧单密钥', () => {
  const registry = new ModelRegistry()
  registry.register({
    id: 'p',
    name: 'P',
    endpoints: {
      'openai-chat-completions': {
        adapterFamily: 'openai-chat-completions',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    models: [],
    apiKeys: [
      { id: 'a', key: 'same', isEnabled: true },
      { id: 'b', key: 'same', isEnabled: false },
      { id: 'c', key: 'other' },
      { id: 'd', key: '   ' },
    ],
    apiKey: 'legacy',
  })
  assert.deepEqual(registry.resolveApiKeys(registry.get('p')), ['same', 'other', 'legacy'])
})

test('Anthropic 端点自动获得 prefill 能力，显式关闭仍尊重', () => {
  const registry = new ModelRegistry()
  registry.register({
    id: 'p',
    name: 'P',
    defaultChatEndpoint: 'anthropic-messages',
    endpoints: {
      'anthropic-messages': {
        adapterFamily: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    models: [{ id: 'm' }],
  })
  assert.equal(supportsAssistantPrefill(registry.resolve('p', 'm')), true)

  const disabled = new ModelRegistry()
  disabled.register({
    id: 'p',
    name: 'P',
    defaultChatEndpoint: 'anthropic-messages',
    endpoints: {
      'anthropic-messages': {
        adapterFamily: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:1',
        supportsAssistantPrefill: false,
      },
    },
    models: [{ id: 'm' }],
  })
  assert.equal(supportsAssistantPrefill(disabled.resolve('p', 'm')), false)

  const openai = new ModelRegistry()
  openai.register({
    id: 'p',
    name: 'P',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': {
        adapterFamily: 'openai-chat-completions',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    models: [{ id: 'm' }],
  })
  assert.equal(supportsAssistantPrefill(openai.resolve('p', 'm')), false)
})

test('SSE 读取器兼容 CRLF 与多行 data', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: one\r\ndata: a\r\ndata: b\r\n\r\n\r\ndata: c\r\n\r\n',
      ))
      controller.close()
    },
  })
  const messages = []
  for await (const message of readSSE(body)) messages.push(message)
  assert.deepEqual(messages, [
    { event: 'one', data: 'a\nb' },
    { data: 'c' },
  ])
})

test('apiUrl 只在 baseUrl 没有版本段时补版本', () => {
  assert.equal(
    apiUrl('https://api.openai.com', '/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  )
  assert.equal(
    apiUrl('https://api.deepseek.com/v1/', '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  )
  assert.equal(
    apiUrl('https://open.bigmodel.cn/api/paas/v4', '/chat/completions'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  )
  assert.equal(
    apiUrl('https://generativelanguage.googleapis.com', '/models/x', 'v1beta'),
    'https://generativelanguage.googleapis.com/v1beta/models/x',
  )
})

test('OpenAI Chat Completions：文本、思考、工具调用与用量', async () => {
  const server = await mockServer((_body, _captured) => ({
    body: [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ].join(''),
  }))
  try {
    const events = await collect(chatModel(request(
      resolvedModel('openai-chat-completions', `${server.baseUrl}/v1`, { apiKey: 'secret' }),
      messages,
    )))
    assert.equal(server.captured.url, '/v1/chat/completions')
    assert.equal(server.captured.headers?.authorization, 'Bearer secret')
    assert.equal(server.captured.body?.model, 'm')
    assert.equal(server.captured.body?.stream, true)
    assert.deepEqual(events, [
      { type: 'text', text: '你' },
      { type: 'reasoning', text: '想' },
      { type: 'tool_call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      { type: 'usage', input: 10, output: 5, cacheRead: 2 },
      { type: 'done' },
    ])
  } finally {
    await server.close()
  }
})

test('OpenAI Responses：delta、function_call 与 instructions', async () => {
  const server = await mockServer(() => ({
    body: [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"read","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"path\\":\\"a\\"}"}\n\n',
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"read","arguments":"{\\"path\\":\\"a\\"}"}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"input_tokens_details":{"cached_tokens":1}}}}\n\n',
    ].join(''),
  }))
  try {
    const events = await collect(chatModel(request(
      resolvedModel('openai-responses', server.baseUrl, { apiKey: 'secret' }),
      messages,
    )))
    assert.equal(server.captured.url, '/v1/responses')
    assert.equal(server.captured.body?.instructions, 'you are a test')
    assert.deepEqual(events, [
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'usage', input: 4, output: 2, cacheRead: 1 },
      { type: 'done' },
    ])
  } finally {
    await server.close()
  }
})

test('Anthropic Messages：tool_use 与缓存用量', async () => {
  const server = await mockServer(() => ({
    body: [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":2}}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join(''),
  }))
  try {
    const events = await collect(chatModel(request(
      resolvedModel('anthropic-messages', server.baseUrl, { apiKey: 'secret' }),
      messages,
    )))
    assert.equal(server.captured.url, '/v1/messages')
    assert.equal(server.captured.headers?.['x-api-key'], 'secret')
    assert.equal(server.captured.headers?.['anthropic-version'], '2023-06-01')
    assert.equal(server.captured.body?.system, 'you are a test')
    assert.equal(server.captured.body?.max_tokens, 4096)
    assert.deepEqual(events, [
      { type: 'text', text: '你' },
      { type: 'tool_call', id: 'toolu_1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'usage', input: 7, output: 3, cacheRead: 2, cacheWrite: 0 },
      { type: 'done' },
    ])
  } finally {
    await server.close()
  }
})

test('assistant prefill 只对声明支持且实现了 prefill 的端点附加', async () => {
  const anthropic = await mockServer(() => ({
    body: 'data: {"type":"message_stop"}\n\n',
  }))
  const openai = await mockServer(() => ({
    body: 'data: [DONE]\n\n',
  }))
  try {
    const base = resolvedModel('anthropic-messages', anthropic.baseUrl)
    const resolved = {
      ...base,
      endpoint: { ...base.endpoint, supportsAssistantPrefill: true },
    }
    await collect(chatModel({
      ...request(resolved, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
      assistantPrefill: '思考头：',
    }))
    const messages = anthropic.captured.body?.messages as Array<{
      role: string
      content: Array<{ text?: string }>
    }>
    assert.equal(messages.at(-1)?.role, 'assistant')
    assert.equal(messages.at(-1)?.content[0]?.text, '思考头：')

    const openaiBase = resolvedModel('openai-chat-completions', `${openai.baseUrl}/v1`)
    const openaiResolved = {
      ...openaiBase,
      endpoint: { ...openaiBase.endpoint, supportsAssistantPrefill: true },
    }
    await collect(chatModel({
      ...request(openaiResolved, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
      assistantPrefill: '思考头：',
    }))
    const openaiMessages = openai.captured.body?.messages as Array<{ role: string; content?: string }>
    assert.equal(openaiMessages.at(-1)?.role, 'assistant')
    assert.equal(openaiMessages.at(-1)?.content, '思考头：')
    assert.equal(openai.captured.body?.continue_final_message, true)

    const unsupportedBase = resolvedModel('anthropic-messages', anthropic.baseUrl)
    await collect(chatModel({
      ...request(unsupportedBase, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
      assistantPrefill: '不生效',
    }))
    const noPrefill = anthropic.captured.body?.messages as Array<{ role: string }>
    assert.notEqual(noPrefill.at(-1)?.role, 'assistant')
  } finally {
    await anthropic.close()
    await openai.close()
  }
})

test('Google Generate Content：functionCall 与 usageMetadata', async () => {
  const server = await mockServer(() => ({
    body: [
      'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":2,"cachedContentTokenCount":1}}\n\n',
    ].join(''),
  }))
  try {
    const events = await collect(chatModel(request(
      resolvedModel('google-generate-content', server.baseUrl, { apiKey: 'secret' }),
      messages,
    )))
    assert.equal(
      server.captured.url,
      '/v1beta/models/m:streamGenerateContent?alt=sse',
    )
    assert.equal(server.captured.headers?.['x-goog-api-key'], 'secret')
    assert.equal(server.captured.body?.systemInstruction instanceof Object, true)
    const toolCall = events.find(event => event.type === 'tool_call')
    assert.ok(toolCall && toolCall.type === 'tool_call')
    assert.match(toolCall.id, /^google_/)
    assert.equal(toolCall.name, 'read')
    assert.equal(toolCall.arguments, '{"path":"a"}')
    assert.deepEqual(events.filter(event => event.type !== 'tool_call'), [
      { type: 'text', text: '你' },
      { type: 'usage', input: 6, output: 2, cacheRead: 1 },
      { type: 'done' },
    ])
  } finally {
    await server.close()
  }
})

test('多 key：401 时换下一个 key；成功一次即停', async () => {
  let count = 0
  const server = await mockServer((_body, captured) => {
    count += 1
    if (captured.headers?.authorization !== 'Bearer good') {
      return { status: 401, body: 'bad key' }
    }
    return {
      body: 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    }
  })
  try {
    const events = await collect(chatModel(request(
      resolvedModel('openai-chat-completions', `${server.baseUrl}/v1`, {
        apiKeys: [
          { id: 'k1', key: 'bad', isEnabled: true },
          { id: 'k2', key: 'good', isEnabled: true },
        ],
      }),
      messages,
    )))
    assert.equal(count, 2)
    assert.deepEqual(events, [
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ])
  } finally {
    await server.close()
  }
})
