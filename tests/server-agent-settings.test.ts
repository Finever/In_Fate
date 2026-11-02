import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { startServer } from '../src/app/server.ts'

function sse(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`
}

function configFor(dataRoot: string, port: number): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [{
      id: 'fake',
      name: 'Fake',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai',
          baseUrl: `http://127.0.0.1:${port}`,
        },
      },
      models: [{ id: 'm' }, { id: 'm2' }],
      apiKey: 'test',
    }],
    presets: [{
      id: 'research',
      description: '查资料',
      models: [{ provider: 'fake', model: 'm' }],
      tools: ['read'],
      maxSteps: 2,
      timeoutMs: 10_000,
      readOnly: true,
    }],
    patch: { tools: { enabled: [] } },
  }
}

test('agent 模型/子 agent/工具策略 API 与未配置模型 409', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-agent-settings-'))
  const dataRoot = join(dir, 'data')
  const configPath = join(dir, 'if.json')
  mkdirSync(dataRoot, { recursive: true })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('ok'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  writeFileSync(configPath, `${JSON.stringify(configFor(dataRoot, port), null, 2)}\n`, 'utf8')

  const app = buildBundle(configFor(dataRoot, port), new Container(), { configPath })
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  }
  try {
    const list = await fetch(`${handle.url}/api/main-agents`, { headers })
    const listBody = await list.json() as {
      agents: Array<{
        id: string
        modelConfigured: boolean
        availablePresets: Array<{ id: string }>
      }>
    }
    assert.equal(listBody.agents.length, 1)
    assert.equal(listBody.agents[0]!.id, 'main')
    assert.equal(listBody.agents[0]!.modelConfigured, false)
    assert.deepEqual(listBody.agents[0]!.availablePresets.map(item => item.id), ['research'])

    const created = await fetch(`${handle.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'main', createdBy: 'user' }),
    })
    const sessionId = (await created.json() as { sessionId: string }).sessionId
    const blocked = await fetch(`${handle.url}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(blocked.status, 409)
    const blockedBody = await blocked.json() as { code: string; agentId: string }
    assert.equal(blockedBody.code, 'EAGENTMODEL')
    assert.equal(blockedBody.agentId, 'main')

    const patched = await fetch(`${handle.url}/api/main-agents/main`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        model: { provider: 'fake', model: 'm' },
        subagentModels: [
          { provider: 'fake', model: 'm' },
          { provider: 'fake', model: 'm2' },
        ],
        subagentPresets: ['research'],
        tools: { allow: ['read', 'fetch'] },
      }),
    })
    assert.equal(patched.status, 200)
    const patchedBody = await patched.json() as {
      agent: {
        modelConfigured: boolean
        model: { provider: string; model: string }
        subagentModels: Array<{ provider: string; model: string }>
      }
    }
    assert.equal(patchedBody.agent.modelConfigured, true)
    assert.deepEqual(patchedBody.agent.model, { provider: 'fake', model: 'm' })
    assert.equal(patchedBody.agent.subagentModels.length, 2)

    const sent = await fetch(`${handle.url}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(sent.status, 200)

    const tools = await fetch(`${handle.url}/api/tools?agentId=main`, { headers })
    const toolsBody = await tools.json() as {
      tools: Array<{ name: string; enabled: boolean; agentAllowed: boolean; approval: string }>
    }
    const read = toolsBody.tools.find(tool => tool.name === 'read')!
    assert.equal(read.enabled, true)
    assert.equal(read.agentAllowed, true)
    const bash = toolsBody.tools.find(tool => tool.name === 'bash')
    assert.equal(bash?.enabled, false)
    assert.equal(bash?.agentAllowed, false)

    const disabled = await fetch(`${handle.url}/api/tools/read`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false, approval: 'required' }),
    })
    assert.equal(disabled.status, 200)
    const disabledBody = await disabled.json() as {
      tools: Array<{ name: string; enabled: boolean; approval: string }>
    }
    const readAfter = disabledBody.tools.find(tool => tool.name === 'read')!
    assert.equal(readAfter.enabled, false)
    assert.equal(readAfter.approval, 'required')

    const agentApproval = await fetch(`${handle.url}/api/main-agents/main`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ tools: { allow: ['read', 'fetch'], approval: { read: 'required' } } }),
    })
    assert.equal(agentApproval.status, 200)
    const agentTools = await fetch(`${handle.url}/api/tools?agentId=main`, { headers })
    const agentToolsBody = await agentTools.json() as {
      tools: Array<{ name: string; agentApproval?: string; effectiveApproval: string }>
    }
    const readAgent = agentToolsBody.tools.find(tool => tool.name === 'read')!
    assert.equal(readAgent.agentApproval, 'required')
    assert.equal(readAgent.effectiveApproval, 'required')

    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      patch: { tools: { disabled: string[]; approval: Record<string, string> } }
    }
    assert.ok(disk.patch.tools.disabled.includes('read'))
    assert.equal(disk.patch.tools.approval.read, 'required')

    const settings = JSON.parse(readFileSync(
      join(dataRoot, 'agents', 'main', 'settings.json'),
      'utf8',
    )) as {
      models: { main: { provider: string; model: string }; subagents: unknown[] }
      tools: { allow: string[] }
    }
    assert.deepEqual(settings.models.main, { provider: 'fake', model: 'm' })
    assert.equal(settings.models.subagents.length, 2)
    assert.deepEqual(settings.tools.allow, ['read', 'fetch'])
  } finally {
    await handle.close()
    await app.dispose()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
