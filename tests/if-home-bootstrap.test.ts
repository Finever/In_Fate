import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AppConfig } from '../src/app/config.ts'
import { bootstrap } from '../src/app/bootstrap.ts'

function config(dataRoot: string): AppConfig {
  return {
    version: 1,
    profile: {
      dataRoot,
      timeZone: 'Asia/Shanghai',
      principals: {
        user: { id: 'user', name: '测试' },
        agents: [{ id: 'main', role: 'main' }],
      },
    },
    providers: [],
    presets: [],
    patch: { tools: { enabled: [] } },
  }
}

test('IF_HOME 覆盖 dataRoot，并在新家目录初始化数据 schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-home-bootstrap-'))
  const home = join(dir, 'home')
  const previous = process.env.IF_HOME
  process.env.IF_HOME = home
  const app = await bootstrap({
    config: config(join(dir, 'configured-data')),
    baseDir: dir,
  })
  try {
    assert.equal(app.config.profile.dataRoot, join(home, 'data'))
    assert.equal(
      existsSync(join(home, 'data', '.state', 'data-schema.json')),
      true,
    )
  } finally {
    await app.dispose()
    if (previous === undefined) delete process.env.IF_HOME
    else process.env.IF_HOME = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
