/**
 * 工具层验证：读、改、写、命令、HTTP、拒绝、参数错误、变更订阅。
 * 全部在临时目录，不碰真项目。
 *
 * @module if/tools/demo
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryApprovalRegistry } from './approval.ts'
import { bashTool } from './builtin/bash.ts'
import { editTool } from './builtin/edit.ts'
import { fetchTool } from './builtin/fetch.ts'
import { readTool } from './builtin/read.ts'
import { writeTool } from './builtin/write.ts'
import { executeTool } from './executor.ts'
import { ToolRegistry } from './registry.ts'

const dir = mkdtempSync(join(tmpdir(), 'if-tools-'))
const file = join(dir, 'a.md')
writeFileSync(file, 'hello world\n', 'utf8')

const registry = new ToolRegistry()
for (const tool of [readTool, writeTool, editTool, bashTool, fetchTool]) {
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

const server = createServer((_request, response) => {
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
