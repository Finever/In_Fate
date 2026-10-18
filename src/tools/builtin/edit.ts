/**
 * edit：精确替换。默认要求 old_string 唯一，找不到或出现多次都拒绝。
 *
 * @module if/tools/builtin/edit
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { ToolDefinition } from '../types.ts'

export const editTool: ToolDefinition = {
  name: 'edit',
  description: '精确替换文件中的一段文本；默认要求匹配唯一。',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', description: '匹配多次时是否全部替换' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  meta: { dangerous: true },

  async run(args) {
    const input = args as {
      file_path: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }

    const original = readFileSync(input.file_path, 'utf8')
    const count = original.split(input.old_string).length - 1

    if (count === 0) throw new Error('old_string not found')
    if (count > 1 && !input.replace_all) {
      throw new Error(`old_string appears ${count} times; add context or set replace_all`)
    }

    const next = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string)

    writeFileSync(input.file_path, next, 'utf8')
    return {
      text: `replaced ${input.replace_all ? count : 1} occurrence(s)`,
      bytes: Buffer.byteLength(next, 'utf8'),
      encoding: 'utf-8',
    }
  },
}
