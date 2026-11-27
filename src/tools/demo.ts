import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryApprovalRegistry } from './approval.ts'
import { bashTool } from './builtin/bash.ts'
import { editTool } from './builtin/edit.ts'
import { fetchTool } from './builtin/fetch.ts'
import { readTool } from './builtin/read.ts'
import { websearchTool } from './builtin/websearch.ts'
import { writeTool } from './builtin/write.ts'
import { executeTool } from './executor.ts'
import { ToolRegistry } from './registry.ts'

const dir = mkdtempSync(join(tmpdir(), 'if-tools-'))
const file = join(dir, 'a.md')
writeFileSync(file, 'hello world\n', 'utf8')

const registry = new ToolRegistry()
for (const tool of [readTool, writeTool, editTool, bashTool, fetchTool, websearchTool]) {
  registry.register(tool)
}
registry.update('write', { approval: 'auto' })
registry.update('edit', { approval: 'auto' })
registry.update('bash', { approval: 'auto' })

const approvals = new InMemoryApprovalRegistry()
const base = { registry, approvals, sessionId: 's1', cwd: dir }

const read1 = await executeTool('read', { file_path: file }, { ...base, callId: 'c1' })
console.log('read:', JSON.stringify(read1.text), read1.bytes, read1.mime)

const edit = await executeTool(
  'edit',
  { file_path: file, old_string: 'world', new_string: 'IF' },
  { ...base, callId: 'c2' },
)
console.log('edit:', edit.text)

const read2 = await executeTool('read', { file_path: file }, { ...base, callId: 'c3' })
console.log('read2:', JSON.stringify(read2.text))

const write = await executeTool(
  'write',
  { file_path: join(dir, 'b.txt'), content: '你好' },
  { ...base, callId: 'c4' },
)
console.log('write:', write.text, 'bytes=', write.bytes)

const bash = await executeTool('bash', { command: 'echo hello' }, { ...base, callId: 'c5' })
const bashStructured = bash.structured as { code: number; stdout: string }
console.log('bash:', JSON.stringify(bashStructured), 'isError=', bash.isError)

// GBK 字节：中、文（D6D0 CEC4），交给 cat 原样输出，验证自动回退
const gbkFile = join(dir, 'gbk.txt')
writeFileSync(gbkFile, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
const gbk = await executeTool(
  'bash',
  { command: `cat "${gbkFile.replace(/\\/g, '/')}"` },
  { ...base, callId: 'c11' },
)
console.log('gbk auto:', JSON.stringify(gbk.text), 'encoding=', gbk.encoding)

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/v1/tools/search') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      results: [{ url: 'https://example.com', title: '示例', snippet: '搜索摘要' }],
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/v1/tools/fetch') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ content: '# 抓取结果' }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('fetched')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0

const fetched = await executeTool(
  'fetch',
  { url: `http://127.0.0.1:${port}/` },
  { ...base, callId: 'c6' },
)
const fetchStructured = fetched.structured as { status: number }
console.log('fetch:', JSON.stringify(fetched.text), 'status=', fetchStructured.status)

process.env.DEEPSEEK_API_KEY = 'test-key'
process.env.DEEPSEEK_WEB_API_BASE = `http://127.0.0.1:${port}/v1/tools`

const search = await executeTool('websearch', { query: 'In_Fate' }, { ...base, callId: 'c9' })
console.log('websearch:', JSON.stringify(search.text))

const deepseek = await executeTool(
  'fetch',
  { url: 'https://example.com', backend: 'deepseek' },
  { ...base, callId: 'c10' },
)
console.log('fetch(deepseek):', JSON.stringify(deepseek.text), deepseek.mime)

server.close()

const denied = await executeTool(
  'bash',
  { command: 'echo nope' },
  { ...base, callId: 'c7', hooks: { guard: () => 'deny' } },
)
console.log('denied:', denied.isError, denied.text)

const invalid = await executeTool('read', {}, { ...base, callId: 'c8' })
console.log('invalid:', invalid.isError, invalid.text)

const changes: string[] = []
registry.onChange(change => changes.push(`${change.type}:${change.name}`))
registry.register({ ...readTool, name: 'read2' }, 'client')
registry.unregister('read2')
console.log('changes:', changes.join(', '))
console.log('specs:', registry.toModelSpecs().map(spec => spec.name).join(', '))
