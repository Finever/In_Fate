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

interface Decoded {
  readonly text: string
  readonly encoding: string
}

/**
 * 自动识别编码：不猜场景，猜字节。
 * 默认先 UTF-8（fatal，遇到非法字节直接抛），失败再 GBK；
 * 显式指定的编码先试，失败回退到另一种。
 */
export function decodeAuto(buffer: Buffer, requested?: string): Decoded {
  const order = requested
    ? [requested, requested.toLowerCase().startsWith('utf') ? 'gbk' : 'utf-8']
    : ['utf-8', 'gbk']

  for (const encoding of order) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(buffer), encoding }
    } catch {
      // 换下一种
    }
  }

  const fallback = order[order.length - 1]
  return { text: new TextDecoder(fallback).decode(buffer), encoding: fallback }
}

/** 单个命令最多保留的输出字节；超过就截断并终止子进程。 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** structured 里再带一份 stdout/stderr 的上限；超过只留字节数。 */
const MAX_STRUCTURED_STREAM_BYTES = 8 * 1024

function execute(
  shell: Shell,
  command: string,
  cwd: string,
  requested: string | undefined,
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
    let total = 0
    let truncated = false

    // stdout 与 stderr 共享一个硬上限，避免整夜命令把进程内存吃光。
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (truncated) return
      const next = total + chunk.length
      if (next > MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - total
        if (remaining > 0) target.push(chunk.subarray(0, remaining))
        total = MAX_OUTPUT_BYTES
        truncated = true
        child.kill()
        return
      }
      total = next
      target.push(chunk)
    }

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.on('error', reject)

    child.on('close', (code: number | null) => {
      const outBuffer = Buffer.concat(stdout)
      const errBuffer = Buffer.concat(stderr)
      const out = decodeAuto(outBuffer, requested)
      const err = decodeAuto(errBuffer, requested)
      const notice = truncated ? `\n…[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : ''
      const text = [out.text, err.text].filter(part => part.length > 0).join('\n') + notice
      const encoding = out.encoding
      const requestedEncoding = requested && requested !== encoding ? requested : undefined

      const structured: Record<string, unknown> = {
        code,
        encodings: { stdout: out.encoding, stderr: err.encoding },
        stdoutBytes: outBuffer.length,
        stderrBytes: errBuffer.length,
        ...(truncated ? { truncated: true, limitBytes: MAX_OUTPUT_BYTES } : {}),
      }

      // 短输出保留分流副本，长输出只留 text，避免同一内容在事件里出现三次。
      if (!truncated && outBuffer.length + errBuffer.length <= MAX_STRUCTURED_STREAM_BYTES) {
        structured.stdout = out.text
        structured.stderr = err.text
      }

      resolve({
        text,
        structured,
        bytes: Buffer.byteLength(text, 'utf8'),
        encoding,
        ...(requestedEncoding ? { requestedEncoding } : {}),
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
      input.encoding,
      context,
    )
  },
}
