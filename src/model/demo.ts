/**
 * 模型适配层验证：本地起一个假 SSE 服务，模拟文本 + 工具调用 + usage。
 * 不连外网、不需要密钥。
 *
 * @module if/model/demo
 */

import { createServer } from 'node:http'
import type { HistoryMessage } from '../projections/history.ts'
import { chatModel } from './chat-model.ts'
import { registerProvider, resolveModel } from './registry.ts'

const sse = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file' } }] } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a.md"}' } }] } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } } })}`,
  'data: [DONE]',
].join('\n\n') + '\n\n'

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', () => {
    const parsed = JSON.parse(body) as { model?: string; tools?: unknown[] }
    console.log('请求：model =', parsed.model, '，tools =', parsed.tools?.length ?? 0)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sse)
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0

registerProvider({
  id: 'mock',
  name: 'Mock Provider',
  defaultChatEndpoint: 'openai-chat-completions',
  endpoints: {
    'openai-chat-completions': {
      adapterFamily: 'openai',
      baseUrl: `http://127.0.0.1:${port}`,
    },
  },
  models: [
    {
      id: 'mock-model',
      capabilities: ['function-call'],
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  ],
})

const resolved = resolveModel('mock', 'mock-model')
const messages: HistoryMessage[] = [
  { role: 'user', content: [{ type: 'text', text: '你好' }] },
]

const events: unknown[] = []
for await (const event of chatModel({
  resolved,
  system: '你是示例助手。',
  messages,
  tools: [
    {
      name: 'Read',
      description: '读取文件',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
  ],
})) {
  events.push(event)
}

console.log('事件：')
for (const event of events) console.log(' ', JSON.stringify(event))

server.close()
