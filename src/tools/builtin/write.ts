/**
 * write：覆盖写入。目前只支持 UTF-8（GBK 编码需要额外的转码原语）。
 *
 * @module if/tools/builtin/write
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolDefinition } from '../types.ts'

export const writeTool: ToolDefinition = {
  name: 'write',
  description: '写文件，覆盖原内容。整文件写入用它；改局部用 edit。',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
      encoding: { type: 'string', description: '目前只支持 utf-8' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  meta: { dangerous: true, writeScope: 'path' },

  async run(args, context) {
    const input = args as { file_path: string; content: string; encoding?: string }
    const encoding = (input.encoding ?? 'utf-8').toLowerCase()
    if (encoding !== 'utf-8' && encoding !== 'utf8') {
      throw new Error(`write currently supports utf-8 only, got ${encoding}`)
    }
    const file = context.sandbox
      ? context.sandbox.resolveWrite(input.file_path, context.cwd)
      : resolve(context.cwd, input.file_path)
    const bytes = Buffer.byteLength(input.content, 'utf8')
    writeFileSync(file, input.content, 'utf8')
    return { text: `wrote ${bytes} bytes`, bytes, encoding: 'utf-8' }
  },
}
