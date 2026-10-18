/**
 * read：按编码读文件，结果带 bytes / encoding / mime。
 *
 * @module if/tools/builtin/read
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
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
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  meta: { readOnly: true },

  async run(args) {
    const input = args as { file_path: string; encoding?: string }
    const buffer = readFileSync(input.file_path)
    const encoding = input.encoding ?? 'utf-8'
    const text = new TextDecoder(encoding).decode(buffer)
    return {
      text,
      bytes: buffer.length,
      encoding,
      mime: MIME[extname(input.file_path).toLowerCase()] ?? 'application/octet-stream',
    }
  },
}
