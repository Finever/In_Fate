/**
 * 本地 UI API：只绑 127.0.0.1，Bearer token。
 *
 * 路由只做转译，不直接读文件；所有数据都从 App 的投影/索引拿。
 * UI 展开全文时按 ref/事件 id 调 /payload，取的是切片，不是整段会话。
 *
 * @module if/app/server
 */

import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { MemoryRole } from '../memory/access.ts'
import { MemoryValidationError, type MemoryDocument } from '../memory/store.ts'
import type { App } from './bundle.ts'

export interface ServeOptions {
  readonly host?: string
  readonly port?: number
  readonly token?: string
  /** 生产 UI 目录；默认不托管静态文件 */
  readonly uiDir?: string
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
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization
  if (header === `Bearer ${token}`) return true
  return url.searchParams.get('token') === token
}

async function readOptionalJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req)
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text) as unknown
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function insideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`)
}

/**
 * 托管生产 UI。API 仍然只认 Bearer token；静态资源本身不含密钥，
 * 但 index.html 需要能先加载出来，token 才能从 URL/输入框进来。
 */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  uiDir: string | undefined,
  pathname: string,
): Promise<boolean> {
  if (!uiDir) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (pathname === '/api' || pathname.startsWith('/api/')) return false

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    json(res, 400, { error: 'invalid path' })
    return true
  }

  const root = resolve(uiDir)
  const index = join(root, 'index.html')
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  let target = resolve(root, relative)
  if (!insideRoot(root, target)) {
    json(res, 403, { error: 'forbidden' })
    return true
  }

  let stat = existsSync(target) ? statSync(target) : undefined
  if (stat?.isDirectory()) {
    target = join(target, 'index.html')
    stat = existsSync(target) ? statSync(target) : undefined
  }

  // 没有扩展名的路径按 SPA 路由回退；缺失的 .js/.css 必须 404，
  // 否则构建产物缺失会伪装成 index.html，排查很痛苦。
  if (!stat?.isFile()) {
    if (extname(decoded)) {
      json(res, 404, { error: 'not found' })
      return true
    }
    target = index
    stat = existsSync(target) ? statSync(target) : undefined
  }

  if (!stat?.isFile()) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('UI 未构建：cd ui && npm run build\n')
    return true
  }

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': target === index
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(target)
    stream.on('error', fail)
    res.on('finish', done)
    res.on('close', done)
    stream.pipe(res)
  })
  return true
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? Math.floor(value) : undefined
}

async function handle(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  uiDir?: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  cors(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 静态 UI 必须在 token 之前：浏览器加载 index.html 和 /assets/* 时
  // 不会带 Bearer；API 仍然只认 token。
  if (url.pathname !== '/api'
    && !url.pathname.startsWith('/api/')
    && await serveStatic(req, res, uiDir, url.pathname)) {
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

  if (req.method === 'GET' && parts[1] === 'metrics' && parts.length === 2) {
    json(res, 200, app.metrics())
    return
  }

  if (req.method === 'GET' && parts[1] === 'model-config' && parts.length === 2) {
    json(res, 200, { config: app.modelConfig() })
    return
  }

  if (req.method === 'POST' && parts[1] === 'model-config' && parts.length === 2) {
    const body = await readOptionalJson(req)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    if (!provider) {
      json(res, 400, { error: 'provider is required' })
      return
    }
    try {
      const config = await app.saveModelConfig({
        provider,
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
      })
      json(res, 200, { config })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'PUT' && parts[1] === 'model-config' && parts[2] === 'models'
    && parts[3] && parts[4] && parts.length === 5) {
    const body = await readOptionalJson(req)
    const contextWindow = body.contextWindow
    const maxOutputTokens = body.maxOutputTokens
    if (contextWindow !== undefined && contextWindow !== null
      && (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow))) {
      json(res, 400, { error: 'contextWindow must be a number or null' })
      return
    }
    if (maxOutputTokens !== undefined && maxOutputTokens !== null
      && (typeof maxOutputTokens !== 'number' || !Number.isFinite(maxOutputTokens))) {
      json(res, 400, { error: 'maxOutputTokens must be a number or null' })
      return
    }
    if (body.pricing !== undefined && body.pricing !== null
      && (typeof body.pricing !== 'object' || Array.isArray(body.pricing))) {
      json(res, 400, { error: 'pricing must be an object or null' })
      return
    }
    try {
      const config = await app.saveModelCard({
        provider: parts[3]!,
        model: parts[4]!,
        ...(contextWindow !== undefined
          ? { contextWindow: contextWindow as number | null }
          : {}),
        ...(maxOutputTokens !== undefined
          ? { maxOutputTokens: maxOutputTokens as number | null }
          : {}),
        ...(body.pricing !== undefined
          ? { pricing: body.pricing as never }
          : {}),
      })
      json(res, 200, { config })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'tools' && parts.length === 2) {
    json(res, 200, { tools: app.toolViews(url.searchParams.get('agentId') ?? undefined) })
    return
  }

  if (req.method === 'PATCH' && parts[1] === 'tools' && parts[2] && parts.length === 3) {
    const body = await readOptionalJson(req)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      json(res, 400, { error: 'enabled must be a boolean' })
      return
    }
    if (body.approval !== undefined && body.approval !== 'auto' && body.approval !== 'required') {
      json(res, 400, { error: 'approval must be auto or required' })
      return
    }
    try {
      const tools = await app.setToolGlobal(parts[2], {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(body.approval === 'auto' || body.approval === 'required'
          ? { approval: body.approval }
          : {}),
      })
      json(res, 200, { tools })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'role') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) {
      json(res, 400, { error: 'sessionId is required' })
      return
    }
    json(res, 200, { sessionId, role: app.memoryRole(sessionId) ?? null })
    return
  }

  if (req.method === 'POST' && parts[1] === 'memory' && parts[2] === 'grant' && parts.length === 3) {
    const body = JSON.parse(await readBody(req)) as { sessionId?: unknown; role?: unknown }
    if (typeof body.sessionId !== 'string' || typeof body.role !== 'string') {
      json(res, 400, { error: 'sessionId and role are required' })
      return
    }
    const role = app.grantMemory(body.sessionId, body.role as MemoryRole)
    json(res, 200, { sessionId: body.sessionId, role })
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'index' && parts.length === 3) {
    json(res, 200, { files: app.memoryIndex() })
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'indexlist' && parts.length === 3) {
    try {
      json(res, 200, { index: app.memoryIndexList() })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'POST' && parts[1] === 'memory' && parts[2] === 'reindex' && parts.length === 3) {
    try {
      json(res, 200, { index: app.reindexMemory() })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'log' && parts[3] === 'tree') {
    try {
      json(res, 200, app.memoryLogTree())
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'log' && parts[3] === 'file') {
    const day = url.searchParams.get('day') ?? ''
    const sid = url.searchParams.get('sid') ?? ''
    if (!day || !sid) {
      json(res, 400, { error: 'day and sid are required' })
      return
    }
    const offset = numberParam(url, 'offset')
    const limit = numberParam(url, 'limit')
    const jumpN = numberParam(url, 'n')
    try {
      json(res, 200, app.memoryLogPage(day, sid, {
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(jumpN !== undefined ? { jumpN } : {}),
      }))
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'log' && parts[3] === 'search') {
    const query = url.searchParams.get('q') ?? ''
    if (!query.trim()) {
      json(res, 200, { hits: [], total: 0 })
      return
    }
    const limit = numberParam(url, 'limit')
    try {
      json(res, 200, app.memoryLogSearch(query, limit ?? 200))
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'PUT' && parts[1] === 'memory' && parts[2] === 'document' && parts.length === 3) {
    let body: { target?: unknown; document?: unknown }
    try {
      body = JSON.parse(await readBody(req)) as { target?: unknown; document?: unknown }
    } catch {
      json(res, 400, { error: 'invalid JSON' })
      return
    }
    if (
      typeof body.target !== 'string'
      || typeof body.document !== 'object'
      || body.document === null
      || Array.isArray(body.document)
    ) {
      json(res, 400, { error: 'target and document are required' })
      return
    }
    try {
      const result = await app.saveMemoryDocument(body.target, body.document as MemoryDocument)
      json(res, 200, result)
    } catch (error) {
      if (error instanceof MemoryValidationError) {
        json(res, 400, {
          error: '记忆文件校验失败',
          issues: error.result.errors,
          warnings: error.result.warnings,
        })
      } else {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'proposals' && parts.length === 3) {
    const status = url.searchParams.get('status')
    json(res, 200, {
      proposals: app.memoryProposals(
        status === 'all' ? undefined : (status === 'accepted' || status === 'rejected'
          ? status
          : 'pending'),
      ),
    })
    return
  }

  if (req.method === 'POST' && parts[1] === 'memory' && parts[2] === 'proposals'
    && parts[3] && parts[4] === 'accept' && parts.length === 5) {
    const entry = await app.acceptMemoryProposal(parts[3])
    json(res, 200, { entry })
    return
  }

  if (req.method === 'POST' && parts[1] === 'memory' && parts[2] === 'proposals'
    && parts[3] && parts[4] === 'reject' && parts.length === 5) {
    const proposal = app.rejectMemoryProposal(parts[3])
    json(res, 200, { proposal })
    return
  }

  if (req.method === 'GET' && parts[1] === 'links' && parts.length === 2) {
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    json(res, 200, { links: app.links(sessionId) })
    return
  }

  if (req.method === 'POST' && parts[1] === 'links' && parts.length === 2) {
    const body = JSON.parse(await readBody(req)) as {
      from?: unknown
      to?: unknown
      relation?: unknown
      permissions?: unknown
      snapshotSeq?: unknown
      reason?: unknown
    }
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      json(res, 400, { error: 'from and to are required' })
      return
    }
    if (body.relation !== undefined && typeof body.relation !== 'string') {
      json(res, 400, { error: 'relation must be a string' })
      return
    }
    const link = app.link({
      from: body.from,
      to: body.to,
      ...(typeof body.relation === 'string' ? { relation: body.relation as 'peer' | 'handoff' | 'reference' } : {}),
      ...(body.permissions && typeof body.permissions === 'object'
        ? { permissions: body.permissions as never }
        : {}),
      ...(typeof body.snapshotSeq === 'number' ? { snapshotSeq: body.snapshotSeq } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    })
    json(res, 200, { link })
    return
  }

  if (req.method === 'POST' && parts[1] === 'links' && parts[2] && parts[3] === 'close') {
    const body = JSON.parse(await readBody(req)) as { reason?: unknown }
    const link = app.unlink(parts[2], typeof body.reason === 'string' ? body.reason : undefined)
    json(res, link ? 200 : 404, link ? { link } : { error: 'link not found' })
    return
  }

  if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 2) {
    const includeArchived = url.searchParams.get('includeArchived') === '1'
      || url.searchParams.get('includeArchived') === 'true'
    const includeDeleted = url.searchParams.get('includeDeleted') === '1'
      || url.searchParams.get('includeDeleted') === 'true'
    json(res, 200, { sessions: app.sessions({ includeArchived, includeDeleted }) })
    return
  }

  if (req.method === 'POST' && parts[1] === 'sessions' && parts.length === 2) {
    const body = await readOptionalJson(req)
    const sessionId = app.createSession({
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : 'user',
      ...(typeof body.agentId === 'string' && body.agentId.trim()
        ? { agentId: body.agentId }
        : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : { reason: 'ui' }),
      materialize: true,
    })
    json(res, 200, { sessionId })
    return
  }

  if (req.method === 'GET' && parts[1] === 'main-agents' && parts.length === 2) {
    json(res, 200, { agents: app.agentSummaries() })
    return
  }

  if (req.method === 'GET' && parts[1] === 'main-agents' && parts[2] && parts.length === 3) {
    try {
      json(res, 200, { agent: app.agentSummary(parts[2]) })
    } catch (error) {
      json(res, 404, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'PATCH' && parts[1] === 'main-agents' && parts[2] && parts.length === 3) {
    const body = await readOptionalJson(req)
    const model = body.model
    if (model !== undefined && (
      typeof model !== 'object'
      || model === null
      || Array.isArray(model)
      || typeof (model as { provider?: unknown }).provider !== 'string'
      || typeof (model as { model?: unknown }).model !== 'string'
    )) {
      json(res, 400, { error: 'model must be { provider, model }' })
      return
    }
    const subagentModels = body.subagentModels
    if (subagentModels !== undefined && !Array.isArray(subagentModels)) {
      json(res, 400, { error: 'subagentModels must be an array' })
      return
    }
    const subagentPresets = body.subagentPresets
    if (subagentPresets !== undefined && !Array.isArray(subagentPresets)) {
      json(res, 400, { error: 'subagentPresets must be an array' })
      return
    }
    const toolsPatch = body.tools
    if (toolsPatch !== undefined
      && (typeof toolsPatch !== 'object' || toolsPatch === null || Array.isArray(toolsPatch))) {
      json(res, 400, { error: 'tools must be an object' })
      return
    }
    try {
      const agent = await app.updateAgentSettings(parts[2], {
        ...(model !== undefined ? { model: model as never } : {}),
        ...(subagentModels !== undefined ? { subagentModels: subagentModels as never } : {}),
        ...(subagentPresets !== undefined ? { subagentPresets: subagentPresets as string[] } : {}),
        ...(toolsPatch !== undefined ? { tools: toolsPatch as never } : {}),
      })
      json(res, 200, { agent })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'POST' && parts[1] === 'main-agents' && parts.length === 2) {
    const body = await readOptionalJson(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!id || !name) {
      json(res, 400, { error: 'id and name are required' })
      return
    }
    try {
      const agent = await app.createMainAgent({ id, name })
      json(res, 200, { agent })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'main-agents' && parts[2]
    && parts[3] === 'identity' && parts.length === 4) {
    try {
      const identity = app.mainAgentIdentity(parts[2])
      json(res, 200, { identity })
    } catch (error) {
      json(res, 404, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'PUT' && parts[1] === 'main-agents' && parts[2]
    && parts[3] === 'identity' && parts[4] && parts.length === 5) {
    const body = await readOptionalJson(req)
    if (typeof body.content !== 'string') {
      json(res, 400, { error: 'content is required' })
      return
    }
    try {
      const result = await app.writeMainAgentSlot(parts[2], parts[4], body.content)
      json(res, 200, { result })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && parts[1] === 'agents' && parts.length === 2) {
    const includeArchived = url.searchParams.get('includeArchived') === '1'
      || url.searchParams.get('includeArchived') === 'true'
    const includeDeleted = url.searchParams.get('includeDeleted') === '1'
      || url.searchParams.get('includeDeleted') === 'true'
    json(res, 200, { agents: app.agentRuns({ includeArchived, includeDeleted }) })
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'search') {
    const q = url.searchParams.get('q') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? 20)
    json(res, 200, { hits: app.memorySearch(q, Number.isFinite(limit) ? limit : 20) })
    return
  }

  if (req.method === 'GET' && parts[1] === 'memory' && parts[2] === 'read') {
    const target = url.searchParams.get('target') ?? ''
    if (!target) {
      json(res, 400, { error: 'target is required' })
      return
    }
    json(res, 200, { document: app.memoryRead(target) })
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

  if (
    req.method === 'POST'
    && (action === 'archive' || action === 'unarchive' || action === 'delete')
    && parts.length === 4
  ) {
    const body = await readOptionalJson(req)
    const input = {
      ...(typeof body.by === 'string' ? { by: body.by } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      ...(body.force === true ? { force: true } : {}),
    }
    const record = action === 'archive'
      ? app.archiveSession(sessionId, input)
      : action === 'unarchive'
        ? app.unarchiveSession(sessionId, input)
        : app.deleteSession(sessionId, input)
    json(res, 200, { session: record })
    return
  }

  if (req.method === 'GET' && action === 'events' && parts.length === 4) {
    const afterSeq = numberParam(url, 'afterSeq')
    const limit = numberParam(url, 'limit')
    json(res, 200, app.sessionEvents(sessionId, {
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }))
    return
  }

  if (req.method === 'GET' && action === 'inspect' && parts.length === 4) {
    json(res, 200, app.inspectSession(sessionId))
    return
  }

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

  if (req.method === 'POST' && action === 'join' && parts.length === 4) {
    const body = JSON.parse(await readBody(req)) as {
      targets?: unknown
      mode?: unknown
      timeoutMs?: unknown
    }
    if (!Array.isArray(body.targets) || body.targets.some(item => typeof item !== 'string')) {
      json(res, 400, { error: 'targets must be a string array' })
      return
    }
    if (body.mode !== undefined && body.mode !== 'all' && body.mode !== 'any') {
      json(res, 400, { error: 'invalid mode' })
      return
    }
    const join = app.join({
      sessionId,
      targets: body.targets as string[],
      ...(typeof body.mode === 'string' ? { mode: body.mode as 'all' | 'any' } : {}),
      ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
    })
    json(res, 200, { join: { ...join, satisfied: [...join.satisfied] } })
    return
  }

  if (req.method === 'GET' && action === 'joins' && parts.length === 4) {
    json(res, 200, {
      joins: app.pendingJoins(sessionId).map(join => ({
        ...join,
        satisfied: [...join.satisfied],
      })),
    })
    return
  }

  if (req.method === 'POST' && action === 'joins' && parts[4] === 'cancel' && parts.length === 5) {
    const body = JSON.parse(await readBody(req)) as { joinId?: unknown }
    const count = app.cancelJoins(
      sessionId,
      typeof body.joinId === 'string' ? body.joinId : undefined,
    )
    json(res, 200, { cancelled: count })
    return
  }

  if (req.method === 'POST' && action === 'inbox' && parts.length === 4) {
    const body = JSON.parse(await readBody(req)) as {
      from?: unknown
      text?: unknown
      kind?: unknown
      linkId?: unknown
      replyTo?: unknown
      wake?: unknown
      hop?: unknown
    }
    if (typeof body.from !== 'string' || typeof body.text !== 'string') {
      json(res, 400, { error: 'from and text are required' })
      return
    }
    if (body.kind !== undefined
      && body.kind !== 'note'
      && body.kind !== 'question'
      && body.kind !== 'result'
      && body.kind !== 'wake') {
      json(res, 400, { error: 'invalid kind' })
      return
    }
    const delivery = app.sendMessage({
      from: body.from,
      to: sessionId,
      text: body.text,
      ...(typeof body.kind === 'string' ? { kind: body.kind as 'note' | 'question' | 'result' | 'wake' } : {}),
      ...(typeof body.linkId === 'string' ? { linkId: body.linkId } : {}),
      ...(typeof body.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
      ...(typeof body.wake === 'boolean' ? { wake: body.wake } : {}),
      ...(typeof body.hop === 'number' ? { hop: body.hop } : {}),
    })
    json(res, 200, delivery)
    return
  }

  if (req.method === 'POST' && action === 'wake' && parts.length === 4) {
    const body = JSON.parse(await readBody(req)) as { text?: unknown }
    try {
      const result = await app.wake(sessionId, typeof body.text === 'string' ? body.text : undefined)
      json(res, 200, { result })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : ''
      const status = code === 'EAGENTMODEL' || code === 'EAGENTMODELINVALID' ? 409 : 500
      json(res, status, {
        error: error instanceof Error ? error.message : String(error),
        ...(code ? { code } : {}),
      })
    }
    return
  }

  if (req.method === 'POST' && action === 'messages' && parts.length === 4) {
    const body = JSON.parse(await readBody(req)) as { text?: unknown }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      json(res, 400, { error: 'text is required' })
      return
    }
    try {
      const result = await app.chat({ sessionId, text: body.text })
      json(res, 200, { result })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : ''
      const agentId = typeof error === 'object' && error !== null && 'agentId' in error
        ? String((error as { agentId?: unknown }).agentId ?? '')
        : undefined
      const status = code === 'EAGENTMODEL' || code === 'EAGENTMODELINVALID' ? 409 : 500
      json(res, status, {
        error: error instanceof Error ? error.message : String(error),
        ...(code ? { code } : {}),
        ...(agentId ? { agentId } : {}),
      })
    }
    return
  }

  json(res, 404, { error: 'not found' })
}

export function startServer(app: App, options: ServeOptions = {}): Promise<ServeHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8787
  const token = options.token ?? process.env.IF_UI_TOKEN ?? randomBytes(16).toString('hex')

  const server = createServer((req, res) => {
    void handle(app, req, res, token, options.uiDir).catch(error => {
      const code = (error as { code?: unknown } | null)?.code
      const status = code === 'ESESSIONBUSY' ? 409 : 500
      json(res, status, { error: error instanceof Error ? error.message : String(error) })
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
