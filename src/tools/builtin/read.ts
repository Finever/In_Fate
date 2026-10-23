/**
 * read：按编码读文件，结果带 bytes / encoding / mime。
 *
 * @module if/tools/builtin/read
 */

import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { ToolDefinition } from '../types.ts'

const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.ts': 'text/typescript',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
  '.html': 'text/html',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
}

export const readTool: ToolDefinition = {
  name: 'read',
  description: '读取文件内容。适合查看源码、配置、日志；大文件先定位再读。中文 Windows 文件可指定 gbk。',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      encoding: { type: 'string', description: '默认 utf-8' },
      offset: { type: 'number', minimum: 0, description: '起始行，0 基；不传从头读' },
      limit: { type: 'number', minimum: 1, description: '最多读多少行；不传读到尾' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  meta: { readOnly: true },

  async run(args, context) {
    const input = args as {
      file_path: string
      encoding?: string
      offset?: number
      limit?: number
    }
    const file = context.sandbox
      ? context.sandbox.resolveRead(input.file_path, context.cwd)
      : resolve(context.cwd, input.file_path)
    const buffer = readFileSync(file)
    const encoding = input.encoding ?? 'utf-8'
    const full = new TextDecoder(encoding).decode(buffer)
    const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'

    if (input.offset === undefined && input.limit === undefined) {
      return { text: full, bytes: buffer.length, encoding, mime }
    }

    const lines = full.split('\n')
    const start = Math.max(0, Math.min(lines.length, Math.floor(input.offset ?? 0)))
    const count = input.limit === undefined
      ? lines.length - start
      : Math.max(0, Math.floor(input.limit))
    const slice = lines.slice(start, start + count)
    const text = slice.join('\n')
    return {
      text,
      structured: {
        offset: start,
        lines: slice.length,
        totalLines: lines.length,
        eof: start + slice.length >= lines.length,
      },
      bytes: Buffer.byteLength(text, 'utf8'),
      encoding,
      mime,
    }
  },
}
