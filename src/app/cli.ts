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
import type { UiTimelineItem } from '../ui/timeline.ts'
import type { PendingApproval } from '../tools/types.ts'
import { bootstrap, classifyError } from './bootstrap.ts'
import type { App } from './bundle.ts'
import { startServer } from './server.ts'

const HELP = `IF — In_Fate

用法：
  if [chat] [-c 配置] [-s 会话]     进入对话（默认）
  if run <文本> [-s 会话]           单轮执行后退出
  if show [会话] [--limit N]        查看会话窗时间线（分页预览）
  if tail [会话] [--limit N]        查看最近几轮（show 的别名）
  if payload <ref|事件id> [-s 会话] 取全文切片（--offset / --limit）
  if stats [会话]                   会话统计
  if metrics                        进程内指标
  if approvals [-s 会话]            待审批队列
  if serve [--port 8787] [--token]  启动本地 UI API（仅 127.0.0.1）
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

function numberArg(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
}

function printTimeline(items: readonly UiTimelineItem[]): void {
  for (const item of items) {
    const tool = item.tool ? ` · ${item.tool.name}` : ''
    stdout.write(`[${item.seq}] ${item.kind}${tool} ${item.title}\n`)
    const text = item.content?.preview ?? item.tool?.result?.preview
    if (text) stdout.write(`  ${oneLine(text, 160)}\n`)
  }
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
      limit: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      offset: { type: 'string' },
      port: { type: 'string' },
      token: { type: 'string' },
      host: { type: 'string' },
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
    } else if (command === 'show' || command === 'tail') {
      const sessionId = typeof values.session === 'string'
        ? values.session
        : (rest[0] ?? app.sessions()[0]?.id)
      if (!sessionId) {
        stdout.write('（没有会话）\n')
        return
      }
      const limit = numberArg(values.limit) ?? 20
      const before = numberArg(values.before)
      const after = numberArg(values.after)
      const page = app.timeline(sessionId, {
        limit,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      })
      if (values.json) {
        stdout.write(JSON.stringify(page, null, 2) + '\n')
      } else {
        printTimeline(page.items)
        stdout.write(
          `\n（${page.turns} 轮；上翻${page.hasMoreBefore ? '有' : '无'}更多，`
          + `下翻${page.hasMoreAfter ? '有' : '无'}更多）\n`,
        )
      }
    } else if (command === 'payload') {
      const target = rest[0]
      if (!target) {
        process.stderr.write('payload: 缺少 ref 或事件 id\n')
        process.exitCode = 1
        return
      }
      const sessionId = typeof values.session === 'string'
        ? values.session
        : app.sessions()[0]?.id
      if (!sessionId) {
        stdout.write('（没有会话）\n')
        return
      }
      const input = target.startsWith('spill:') || target.startsWith('blob:')
        ? { ref: target }
        : { eventId: target }
      const slice = app.payload(sessionId, {
        ...input,
        ...(numberArg(values.offset) !== undefined ? { offset: numberArg(values.offset)! } : {}),
        ...(numberArg(values.limit) !== undefined ? { limit: numberArg(values.limit)! } : {}),
      })
      if (values.json) {
        stdout.write(JSON.stringify({ ...slice, data: undefined }, null, 2) + '\n')
        stdout.write(slice.data + (slice.eof ? '' : '\n'))
      } else {
        stdout.write(slice.data)
        if (!slice.eof) stdout.write('\n…\n')
      }
    } else if (command === 'stats') {
      const sessionId = typeof values.session === 'string'
        ? values.session
        : (rest[0] ?? app.sessions()[0]?.id)
      if (!sessionId) {
        stdout.write('（没有会话）\n')
        return
      }
      const stats = app.uiStats(sessionId)
      stdout.write(values.json
        ? JSON.stringify(stats, null, 2) + '\n'
        : `${stats.sessionId}\t${stats.events} 事件\t${stats.turns} 轮\t`
          + `${stats.compacted} 次压缩\t${stats.fileBytes} bytes\t${stats.segments} 段\n`)
    } else if (command === 'metrics') {
      stdout.write(JSON.stringify(app.metrics(), null, 2) + '\n')
    } else if (command === 'approvals') {
      const items = app.uiApprovals(typeof values.session === 'string' ? values.session : undefined)
      if (items.length === 0) stdout.write('（没有待审批）\n')
      for (const item of items) {
        stdout.write(`${item.approvalId}\t${item.toolName}\t${JSON.stringify(item.input)}\n`)
      }
    } else if (command === 'serve') {
      const handle = await startServer(app, {
        ...(typeof values.port === 'string' ? { port: numberArg(values.port) ?? 8787 } : {}),
        ...(typeof values.token === 'string' ? { token: values.token } : {}),
        ...(typeof values.host === 'string' ? { host: values.host } : {}),
      })
      stdout.write(`IF UI API: ${handle.url}\n`)
      stdout.write(`Token: ${handle.token}\n`)
      stdout.write('Ctrl-C 停止。\n')
      await new Promise<void>(resolve => {
        const stop = (): void => {
          process.off('SIGINT', stop)
          resolve()
        }
        process.on('SIGINT', stop)
      })
      await handle.close()
      return
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
    if (result.error) process.stderr.write(`[error] ${result.error}\n`)
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

  // 两条中断路径：正在跑模型就 abort 这一轮；闲在提示符就退出。
  let controller: AbortController | undefined
  rl.on('SIGINT', () => {
    if (controller) {
      controller.abort(new Error('interrupted by user'))
      stdout.write('\n[已中断]\n')
      return
    }
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
      controller = new AbortController()
      try {
        const result = await app.chat({
          sessionId,
          text,
          onModelEvent: printer.onModelEvent,
          signal: controller.signal,
        })
        if (result.error) process.stderr.write(`[error] ${result.error}\n`)
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
      } finally {
        controller = undefined
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
