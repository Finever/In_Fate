/**
 * CLI：chat / run / tools / agents / compact / config / doctor。
 *
 * chat 是 REPL；退出时先等子 agent 到终态，再关闭调度器与存储。
 * 危险工具执行前由 approvalHandler 询问；非交互环境默认拒绝。
 *
 * @module if/app/cli
 */

import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import type { ModelEvent } from '../model/types.ts'
import type { ChatMessage } from '../projections/history.ts'
import type { PendingApproval } from '../tools/types.ts'
import { bootstrap, classifyError } from './bootstrap.ts'
import type { App } from './bundle.ts'

const HELP = `IF — In_Fate

用法：
  if [chat] [-c 配置] [-s 会话]     进入对话（默认）
  if run <文本> [-s 会话]           单轮执行后退出
  if tools                          列出工具
  if agents                         列出子 agent
  if compact [-s 会话]              手动压缩
  if sessions                       列出会话
  if config                         打印生效配置（密钥打码）
  if doctor                         自检

REPL 命令：
  /new            新建会话
  /sessions       列出会话
  /session <id>   切换会话
  /agents         查看子 agent
  /compact        手动压缩
  /status         当前会话
  /help           帮助
  /exit           退出
`

interface Printer {
  onModelEvent: (event: ModelEvent) => void
  wrote: () => boolean
  end: () => void
}

function makePrinter(): Printer {
  let wrote = false
  return {
    onModelEvent(event) {
      if (event.type === 'text') {
        stdout.write(event.text)
        wrote = true
      } else if (event.type === 'tool_call') {
        stdout.write(`\n· ${event.name}\n`)
        wrote = true
      }
    },
    wrote: () => wrote,
    end() {
      if (wrote) stdout.write('\n')
      wrote = false
    },
  }
}

/** 流式没吐字时兜底：直接读投影里的最后一条 assistant。 */
function lastAssistantText(app: App, sessionId: string): string {
  const last = [...app.history(sessionId)]
    .reverse()
    .find((message): message is ChatMessage => message.role === 'assistant')
  return last?.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max) + '…'
}

function statsText(result: { steps: number; usage: { input: number; output: number; cacheRead: number } }): string {
  const { steps, usage } = result
  return `（${steps} 步 · 输入 ${usage.input} / 输出 ${usage.output} / 缓存 ${usage.cacheRead}）`
}

async function askApproval(entry: PendingApproval, question: (text: string) => Promise<string>): Promise<{ approved: boolean; reason?: string }> {
  if (!stdin.isTTY) return { approved: false, reason: 'non-interactive: denied' }
  const answer = await question(
    `\n[审批] ${entry.toolName} ${JSON.stringify(entry.originalInput)}\n允许执行吗？(y/N) `,
  )
  return /^y(es)?$/i.test(answer.trim())
    ? { approved: true }
    : { approved: false, reason: 'denied by user' }
}

export async function runCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      session: { type: 'string', short: 's' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    stdout.write(HELP)
    return
  }

  const command = positionals[0] ?? 'chat'
  const rest = positionals.slice(1)

  let app: App
  try {
    app = await bootstrap({
      ...(values.config ? { configPath: values.config } : {}),
      cwd: process.cwd(),
    })
  } catch (error) {
    const kind = classifyError(error)
    process.stderr.write(`[${kind}] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }

  try {
    if (command === 'chat') {
      await chat(app, typeof values.session === 'string' ? values.session : undefined)
    } else if (command === 'run') {
      const text = rest.join(' ').trim()
      if (!text) {
        process.stderr.write('run: 缺少文本\n')
        process.exitCode = 1
        return
      }
      await runOnce(app, typeof values.session === 'string' ? values.session : app.createSession(), text, Boolean(values.json))
    } else if (command === 'tools') {
      for (const tool of app.tools.list({ includeDisabled: true })) {
        stdout.write(`${tool.name}\t${tool.source}\t${tool.approval}\t${tool.enabled ? 'on' : 'off'}\n`)
      }
    } else if (command === 'agents') {
      const items = app.agentRuns()
      if (items.length === 0) stdout.write('（没有子 agent）\n')
      for (const item of items) {
        stdout.write(`${item.id} [${item.status}] ${item.preset} ${oneLine(item.summary)}\n`)
      }
    } else if (command === 'compact') {
      const sessionId = typeof values.session === 'string'
        ? values.session
        : app.sessions()[0]?.id
      if (!sessionId) {
        stdout.write('（没有会话）\n')
        return
      }
      const payload = await app.compact(sessionId)
      stdout.write(payload ? JSON.stringify(payload, null, 2) + '\n' : '（未达到压缩阈值）\n')
    } else if (command === 'sessions') {
      const sessions = app.sessions()
      if (sessions.length === 0) stdout.write('（没有会话）\n')
      for (const session of sessions) {
        stdout.write(`${session.id}\t${session.bytes} bytes\t${session.updatedAt}\n`)
      }
    } else if (command === 'config') {
      const redacted = JSON.stringify(app.config, (key, value) => key === 'apiKey' ? '***' : value, 2)
      stdout.write(redacted + '\n')
    } else if (command === 'doctor') {
      doctor(app)
    } else {
      process.stderr.write(`未知命令：${command}\n\n${HELP}`)
      process.exitCode = 1
    }
  } finally {
    const pending = await app.waitForAgents(30_000)
    if (pending.active > 0 || pending.queued > 0) {
      process.stderr.write(`退出时仍有子 agent：运行 ${pending.active}，排队 ${pending.queued}\n`)
    }
    await app.dispose()
  }
}

async function runOnce(app: App, sessionId: string, text: string, json: boolean): Promise<void> {
  const printer = makePrinter()
  try {
    const result = await app.chat({ sessionId, text, onModelEvent: printer.onModelEvent })
    const streamed = printer.wrote()
    printer.end()
    const content = lastAssistantText(app, sessionId)
    if (!streamed && content) stdout.write(content + '\n')
    if (json) {
      stdout.write(JSON.stringify({ sessionId, result, text: content }, null, 2) + '\n')
    } else {
      stdout.write(statsText(result) + '\n')
    }
  } catch (error) {
    printer.end()
    throw error
  }
}

async function chat(app: App, initialSession?: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })
  let sessionId = initialSession ?? app.sessions()[0]?.id ?? app.createSession()

  app.approvals.approvalHandler = entry => askApproval(entry, text => rl.question(text))

  rl.on('SIGINT', () => {
    stdout.write('\n')
    rl.close()
  })

  stdout.write(`IF · 会话 ${sessionId}\n输入 /help 查看命令。\n`)

  try {
    while (true) {
      let line: string
      try {
        line = await rl.question('> ')
      } catch {
        break
      }

      const text = line.trim()
      if (!text) continue

      if (text === '/exit' || text === '/quit') break
      if (text === '/help') {
        stdout.write(HELP)
        continue
      }
      if (text === '/new') {
        sessionId = app.createSession()
        stdout.write(`新会话 ${sessionId}\n`)
        continue
      }
      if (text === '/sessions') {
        const sessions = app.sessions()
        if (sessions.length === 0) stdout.write('（没有会话）\n')
        for (const session of sessions) {
          stdout.write(`${session.id === sessionId ? '*' : ' '} ${session.id}  ${session.bytes} bytes\n`)
        }
        continue
      }
      if (text.startsWith('/session ')) {
        sessionId = text.slice('/session '.length).trim()
        stdout.write(`当前会话 ${sessionId}\n`)
        continue
      }
      if (text === '/agents') {
        const items = app.agentRuns().slice(0, 20)
        if (items.length === 0) stdout.write('（没有子 agent）\n')
        for (const item of items) {
          stdout.write(`${item.id} [${item.status}] ${item.preset} ${oneLine(item.summary)}\n`)
        }
        continue
      }
      if (text === '/compact') {
        const payload = await app.compact(sessionId)
        stdout.write(payload ? JSON.stringify(payload.summary, null, 2) + '\n' : '（未达到压缩阈值）\n')
        continue
      }
      if (text === '/status') {
        const count = app.history(sessionId).length
        const agents = app.agentList(100)
        const running = agents.filter(item => item.status === 'running' || item.status === 'queued').length
        stdout.write(`会话 ${sessionId} · ${count} 条消息 · 子 agent ${running} 个进行中\n`)
        continue
      }

      const printer = makePrinter()
      try {
        const result = await app.chat({ sessionId, text, onModelEvent: printer.onModelEvent })
        const streamed = printer.wrote()
        printer.end()
        if (!streamed) {
          const content = lastAssistantText(app, sessionId)
          if (content) stdout.write(content + '\n')
        }
        stdout.write(statsText(result) + '\n')
      } catch (error) {
        printer.end()
        process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  } finally {
    rl.close()
  }
}

function doctor(app: App): void {
  const checks: { name: string; ok: boolean; detail: string }[] = []

  const dataRoot = app.config.profile.dataRoot
  try {
    mkdirSync(dataRoot, { recursive: true })
    accessSync(dataRoot, constants.W_OK)
    checks.push({ name: 'dataRoot', ok: true, detail: dataRoot })
  } catch (error) {
    checks.push({ name: 'dataRoot', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }

  const missing: string[] = []
  for (const source of app.config.profile.agentDir
    ? [app.config.profile.agentDir]
    : []) {
    if (!existsSync(source)) missing.push(source)
  }
  checks.push({
    name: 'agentDir',
    ok: missing.length === 0,
    detail: missing.length === 0 ? (app.config.profile.agentDir ?? '未配置') : `缺失：${missing.join('、')}`,
  })

  const model = app.models.resolve(app.config.defaultModel.provider, app.config.defaultModel.model)
  const hasKey = Boolean(app.models.resolveApiKey(model.provider) || model.provider.apiKey)
  checks.push({
    name: 'defaultModel',
    ok: true,
    detail: `${model.provider.id}/${model.model.id}${hasKey ? '' : '（未找到密钥，环境变量可能未设置）'}`,
  })

  checks.push({
    name: 'tools',
    ok: app.tools.list().length > 0,
    detail: `${app.tools.list().length} 个可用，危险工具：${app.tools.list().some(tool => tool.approval === 'required') ? '已启用' : '未启用'}`,
  })

  checks.push({
    name: 'presets',
    ok: app.presets.list().length > 0,
    detail: app.presets.list().map(preset => preset.id).join('、') || '（无预设，子 agent 不可用）',
  })

  for (const check of checks) {
    stdout.write(`${check.ok ? 'ok  ' : 'fail'} ${check.name}\t${check.detail}\n`)
  }
}
