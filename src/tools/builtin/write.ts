/**
 * write：覆盖写入。目前只支持 UTF-8（GBK 编码需要额外的转码原语）。
 *
 * @module if/tools/builtin/write
 */

import { writeFileSync } from 'node:fs'
import type { ToolDefinition } from '../types.ts'

export const writeTool: ToolDefinition = {
  name: 'write',
  description: '写入文件，覆盖原内容。',
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
  meta: { dangerous: true },

  async run(args) {
    const input = args as { file_path: string; content: string; encoding?: string }
    const encoding = (input.encoding ?? 'utf-8').toLowerCase()
    if (encoding !== 'utf-8' && encoding !== 'utf8') {
      throw new Error(`write currently supports utf-8 only, got ${encoding}`)
    }
    const bytes = Buffer.byteLength(input.content, 'utf8')
    writeFileSync(input.file_path, input.content, 'utf8')
    return { text: `wrote ${bytes} bytes`, bytes, encoding: 'utf-8' }
  },
}
