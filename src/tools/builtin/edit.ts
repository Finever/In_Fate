import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolDefinition } from '../types.ts'

export const editTool: ToolDefinition = {
  name: 'edit',
  description: '精确替换文件中的一段文本。old_string 默认要求唯一；多处替换设 replace_all。',
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
  meta: { dangerous: true, writeScope: 'path' },

  async run(args, context) {
    const input = args as {
      file_path: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }

    const file = context.sandbox
      ? context.sandbox.resolveWrite(input.file_path, context.cwd)
      : resolve(context.cwd, input.file_path)
    const original = readFileSync(file, 'utf8')
    const count = original.split(input.old_string).length - 1

    if (count === 0) throw new Error('old_string not found')
    if (count > 1 && !input.replace_all) {
      throw new Error(`old_string appears ${count} times; add context or set replace_all`)
    }

    const next = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string)

    writeFileSync(file, next, 'utf8')
    return {
      text: `replaced ${input.replace_all ? count : 1} occurrence(s)`,
      bytes: Buffer.byteLength(next, 'utf8'),
      encoding: 'utf-8',
    }
  },
}
