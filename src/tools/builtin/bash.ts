/**
 * bash：执行 shell 命令，可指定编码、cwd、超时。
 * stdout 与 stderr 分开保留在 structured 里；text 是两者拼接。
 *
 * @module if/tools/builtin/bash
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts'

interface Shell {
  readonly path: string
  readonly args: (command: string) => string[]
}

function shellFor(): Shell {
  if (process.platform === 'win32') {
    const bash = process.env.SHELL ?? 'C:/Program Files/Git/bin/bash.exe'
    if (existsSync(bash)) return { path: bash, args: command => ['-lc', command] }
    return {
      path: process.env.ComSpec ?? 'cmd.exe',
      args: command => ['/d', '/s', '/c', command],
    }
  }
  return { path: '/bin/sh', args: command => ['-lc', command] }
}

function execute(
  shell: Shell,
  command: string,
  cwd: string,
  encoding: string,
  context: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell.path, shell.args(command), {
      cwd,
      env: process.env,
      signal: context.signal,
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)

    child.on('close', (code: number | null) => {
      const out = new TextDecoder(encoding).decode(Buffer.concat(stdout))
      const err = new TextDecoder(encoding).decode(Buffer.concat(stderr))
      const text = [out, err].filter(part => part.length > 0).join('\n')
      resolve({
        text,
        structured: { code, stdout: out, stderr: err },
        bytes: Buffer.byteLength(text, 'utf8'),
        encoding,
        isError: code !== 0,
      })
    })
  })
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令。适合跑测试、git、构建。中文 Windows 输出可指定 gbk；长输出用 head/tail 截断。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      encoding: { type: 'string', description: '默认 utf-8' },
      timeoutMs: { type: 'number', description: '覆盖默认超时' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  meta: { dangerous: true },

  async run(args, context) {
    const input = args as { command: string; cwd?: string; encoding?: string }
    return execute(
      shellFor(),
      input.command,
      input.cwd ?? context.cwd,
      input.encoding ?? 'utf-8',
      context,
    )
  },
}
