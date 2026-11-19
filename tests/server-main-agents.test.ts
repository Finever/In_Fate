import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { startServer } from '../src/app/server.ts'

function configFor(dataRoot: string, memoryRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      memoryLogRoot: memoryRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user' }, agents: [{ id: 'main' }] },
    },
    providers: [{
      id: 'fake',
      name: 'fake',
      defaultChatEndpoint: 'openai-chat-completions',
      endpoints: {
        'openai-chat-completions': {
          adapterFamily: 'openai',
          baseUrl: 'http://127.0.0.1:1',
        },
      },
      models: [{ id: 'm' }],
      apiKey: 'test',
    }],
    presets: [],
    defaultModel: { provider: 'fake', model: 'm' },
    patch: { tools: { enabled: [] } },
  }
}

test('main agent 创建、PPP 读写、会话 agentId 与全局记忆 API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-main-agent-'))
  const dataRoot = join(dir, 'data')
  const memoryRoot = join(dir, 'memory')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(join(memoryRoot, 'detail', '测试'), { recursive: true })
  writeFileSync(join(memoryRoot, 'detail', '测试', '记忆.json'), JSON.stringify({
    project: '测试',
    filename: '记忆',
    introduction: '测试记忆',
    entries: [{
      id: '记忆-0001',
      'rec-time': '2026-10-31 17:25',
      'rev-time': null,
      at: '2026-10-31',
      tag: '确信',
      content: '这是一条测试记忆。',
      quotes: [],
    }],
  }), 'utf8')

  const app = buildBundle(configFor(dataRoot, memoryRoot), new Container())
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  }
  try {
    const empty = await fetch(`${handle.url}/api/main-agents`, { headers })
    assert.equal(empty.status, 200)
    const emptyAgents = (await empty.json() as {
      agents: Array<{ id: string; modelConfigured: boolean }>
    }).agents
    assert.equal(emptyAgents.length, 1)
    assert.equal(emptyAgents[0]!.id, 'main')
    assert.equal(emptyAgents[0]!.modelConfigured, false)

    const created = await fetch(`${handle.url}/api/main-agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'main', name: '主 agent' }),
    })
    assert.equal(created.status, 200)
    const createdBody = await created.json() as { agent: { id: string; name: string } }
    assert.equal(createdBody.agent.id, 'main')
    assert.equal(createdBody.agent.name, '主 agent')

    const identity = await fetch(`${handle.url}/api/main-agents/main/identity`, { headers })
    assert.equal(identity.status, 200)
    const identityBody = await identity.json() as {
      identity: { slots: Array<{ id: string; content: string }> }
    }
    assert.equal(identityBody.identity.slots.length, 3)
    assert.match(identityBody.identity.slots[0]!.content, /# 原则/)

    const put = await fetch(`${handle.url}/api/main-agents/main/identity/principle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ content: '# 原则\n\n## 正文\n\n新的。\n' }),
    })
    assert.equal(put.status, 200)
    const readAfter = await fetch(`${handle.url}/api/main-agents/main/identity`, { headers })
    const readBody = await readAfter.json() as {
      identity: { slots: Array<{ id: string; content: string }> }
    }
    assert.match(readBody.identity.slots.find(slot => slot.id === 'principle')!.content, /新的。/)

    const other = await fetch(`${handle.url}/api/main-agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'other', name: '其他 agent' }),
    })
    assert.equal(other.status, 200)
    const deleteMain = await fetch(`${handle.url}/api/main-agents/main`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(deleteMain.status, 400)
    const deleteOther = await fetch(`${handle.url}/api/main-agents/other`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(deleteOther.status, 200)
    const deleted = await deleteOther.json() as { deleted: { id: string; trash: string[] } }
    assert.equal(deleted.deleted.id, 'other')
    assert.equal(deleted.deleted.trash.length, 1)
    const afterDelete = await fetch(`${handle.url}/api/main-agents`, { headers })
    const afterAgents = (await afterDelete.json() as {
      agents: Array<{ id: string; sessionCount: number; deletable: boolean }>
    }).agents
    assert.equal(afterAgents.some(agent => agent.id === 'other'), false)
    assert.equal(afterAgents[0]!.deletable, false)

    const session = await fetch(`${handle.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'main' }),
    })
    assert.equal(session.status, 200)
    const sessionId = (await session.json() as { sessionId: string }).sessionId
    const listed = await fetch(`${handle.url}/api/sessions`, { headers })
    const sessions = (await listed.json() as {
      sessions: Array<{ id: string; agentId?: string }>
    }).sessions
    assert.equal(sessions.find(item => item.id === sessionId)?.agentId, 'main')

    const search = await fetch(`${handle.url}/api/memory/search?q=${encodeURIComponent('测试')}`, { headers })
    assert.equal(search.status, 200)
    const hits = (await search.json() as { hits: Array<{ target: string }> }).hits
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.target, 'detail:测试/记忆')

    const readMemory = await fetch(
      `${handle.url}/api/memory/read?target=${encodeURIComponent('detail:测试/记忆')}`,
      { headers },
    )
    assert.equal(readMemory.status, 200)
    const document = (await readMemory.json() as {
      document: { entries: Array<{ content: string }> }
    }).document
    assert.equal(document.entries[0]!.content, '这是一条测试记忆。')
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
