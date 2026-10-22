/**
 * 本地 UI API：只绑 127.0.0.1，Bearer token。
 *
 * 路由只做转译，不直接读文件；所有数据都从 App 的投影/索引拿。
 * UI 展开全文时按 ref/事件 id 调 /payload，取的是切片，不是整段会话。
 *
 * @module if/app/server
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { App } from './bundle.ts'

export interface ServeOptions {
  readonly host?: string
  readonly port?: number
  readonly token?: string
}

export interface ServeHandle {
  readonly url: string
  readonly token: string
  readonly port: number
  close(): Promise<void>
}

const BODY_LIMIT = 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (typeof origin === 'string'
    && (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization
  if (header === `Bearer ${token}`) return true
  return url.searchParams.get('token') === token
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? Math.floor(value) : undefined
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  cors(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (!authorized(req, url, token)) {
    json(res, 401, { error: 'unauthorized' })
    return
  }

  const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part))
  if (parts[0] !== 'api') {
    json(res, 404, { error: 'not found' })
    return
  }

  if (req.method === 'GET' && parts[1] === 'health') {
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 2) {
    json(res, 200, { sessions: app.sessions() })
    return
  }

  if (req.method === 'GET' && parts[1] === 'agents' && parts.length === 2) {
    json(res, 200, { agents: app.agentRuns() })
    return
  }

  if (req.method === 'GET' && parts[1] === 'approvals' && parts.length === 2) {
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    json(res, 200, { approvals: app.uiApprovals(sessionId) })
    return
  }

  if (req.method === 'POST' && parts[1] === 'approvals' && parts[2]) {
    const body = JSON.parse(await readBody(req)) as {
      approved?: unknown
      reason?: unknown
      updatedInput?: unknown
    }
    if (typeof body.approved !== 'boolean') {
      json(res, 400, { error: 'approved must be boolean' })
      return
    }
    const ok = app.approvals.respond(parts[2], {
      approved: body.approved,
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      ...(body.updatedInput && typeof body.updatedInput === 'object'
        ? { updatedInput: body.updatedInput as Record<string, unknown> }
        : {}),
    })
    json(res, ok ? 200 : 404, { ok })
    return
  }

  if (parts[1] !== 'sessions' || !parts[2]) {
    json(res, 404, { error: 'not found' })
    return
  }

  const sessionId = parts[2]
  const action = parts[3]

  if (req.method === 'GET' && action === 'timeline' && parts.length === 4) {
    const before = numberParam(url, 'before')
    const after = numberParam(url, 'after')
    const limit = numberParam(url, 'limit')
    json(res, 200, app.timeline(sessionId, {
      ...(limit !== undefined ? { limit } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    }))
    return
  }

  if (req.method === 'GET' && action === 'turns' && parts.length === 4) {
    json(res, 200, { turns: app.uiTurns(sessionId) })
    return
  }

  if (req.method === 'GET' && action === 'turns' && parts[4] && parts.length === 5) {
    const turn = Number(parts[4])
    if (!Number.isFinite(turn)) {
      json(res, 400, { error: 'invalid turn' })
      return
    }
    json(res, 200, { turn, items: app.uiTurnItems(sessionId, turn) })
    return
  }

  if (req.method === 'GET' && action === 'payload' && parts.length === 4) {
    const ref = url.searchParams.get('ref') ?? undefined
    const eventId = url.searchParams.get('eventId') ?? undefined
    const offset = numberParam(url, 'offset')
    const limit = numberParam(url, 'limit')
    json(res, 200, app.payload(sessionId, {
      ...(ref ? { ref } : {}),
      ...(eventId ? { eventId } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }))
    return
  }

  if (req.method === 'GET' && action === 'stats' && parts.length === 4) {
    json(res, 200, app.uiStats(sessionId))
    return
  }

  if (req.method === 'POST' && action === 'messages' && parts.length === 4) {
    const body = JSON.parse(await readBody(req)) as { text?: unknown }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      json(res, 400, { error: 'text is required' })
      return
    }
    const result = await app.chat({ sessionId, text: body.text })
    json(res, 200, { result })
    return
  }

  json(res, 404, { error: 'not found' })
}

export function startServer(app: App, options: ServeOptions = {}): Promise<ServeHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8787
  const token = options.token ?? process.env.IF_UI_TOKEN ?? randomBytes(16).toString('hex')

  const server = createServer((req, res) => {
    void handle(app, req, res, token).catch(error => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://${host}:${address.port}`,
        token,
        port: address.port,
        close: () => new Promise<void>(done => {
          server.closeAllConnections?.()
          server.close(() => done())
        }),
      })
    })
  })
}
