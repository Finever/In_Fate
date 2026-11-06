import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundle } from '../src/app/bundle.ts'
import type { AppConfig } from '../src/app/config.ts'
import { Container } from '../src/app/container.ts'
import { startServer } from '../src/app/server.ts'

function configFor(dataRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: { user: { id: 'user', name: '触久' }, agents: [{ id: 'main', name: '未凉' }] },
    },
    providers: [],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
}

test('记忆库根与策略 HTTP：默认 rag-tool，可按 agent 覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-server-memory-policy-'))
  const dataRoot = join(dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const app = buildBundle(configFor(dataRoot), new Container())
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' }
  try {
    const root = await fetch(`${handle.url}/api/memory/root`, { headers })
    assert.deepEqual(await root.json(), { root: join(dataRoot, 'memory') })

    const initial = await fetch(`${handle.url}/api/memory/policy`, { headers })
    const initialBody = await initial.json() as {
      policy: { mode: string; write: { approval: string } }
    }
    assert.equal(initialBody.policy.mode, 'rag-tool')
    assert.equal(initialBody.policy.write.approval, 'required')

    const set = await fetch(`${handle.url}/api/memory/policy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'agent',
        id: 'main',
        policy: {
          mode: 'jev-push',
          write: { approval: 'off' },
          jev: { enabled: 'once' },
        },
      }),
    })
    assert.equal(set.status, 200)
    const setBody = await set.json() as {
      policy: { mode: string; write: { approval: string }; jev: { enabled: string } }
    }
    assert.equal(setBody.policy.mode, 'jev-push')
    assert.equal(setBody.policy.write.approval, 'off')
    assert.equal(setBody.policy.jev.enabled, 'once')

    const disk = JSON.parse(readFileSync(join(dataRoot, 'memory', 'policy.json'), 'utf8')) as {
      agents: Record<string, { mode?: string }>
    }
    assert.equal(disk.agents.main?.mode, 'jev-push')
    assert.equal(existsSync(join(dataRoot, 'memory', 'policy.json')), true)
  } finally {
    await handle.close()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
