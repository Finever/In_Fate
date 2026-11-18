import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DATA_SCHEMA_VERSION,
  DataSchemaError,
  ensureDataSchema,
} from '../src/app/data-schema.ts'

function statePath(root: string): string {
  return join(root, '.state', 'data-schema.json')
}

test('数据 schema：首次写入、同版本更新 appVersion、拒绝降级', async () => {
  const root = mkdtempSync(join(tmpdir(), 'if-schema-'))
  try {
    const first = await ensureDataSchema(root, '0.0.1', {
      now: () => new Date('2026-11-18T00:00:00.000Z'),
    })
    assert.equal(first.version, DATA_SCHEMA_VERSION)
    assert.equal(first.appVersion, '0.0.1')
    assert.equal(JSON.parse(readFileSync(statePath(root), 'utf8')).version, DATA_SCHEMA_VERSION)

    const second = await ensureDataSchema(root, '0.0.2')
    assert.equal(second.version, DATA_SCHEMA_VERSION)
    assert.equal(second.appVersion, '0.0.2')

    writeFileSync(statePath(root), `${JSON.stringify({
      version: DATA_SCHEMA_VERSION + 1,
      appVersion: '9.0.0',
      updatedAt: new Date().toISOString(),
    })}\n`, 'utf8')
    await assert.rejects(
      () => ensureDataSchema(root, '0.0.3'),
      (error: unknown) => error instanceof DataSchemaError && /refusing to downgrade/.test(error.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('数据 schema：旧版本没有迁移就拒绝，有迁移才升级并备份状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'if-schema-migrate-'))
  try {
    mkdirSync(join(root, '.state'), { recursive: true })
    writeFileSync(statePath(root), `${JSON.stringify({
      version: 0,
      appVersion: '0.0.0',
      updatedAt: new Date(0).toISOString(),
    })}\n`, 'utf8')

    await assert.rejects(
      () => ensureDataSchema(root, '0.0.1', { targetVersion: 1 }),
      (error: unknown) => error instanceof DataSchemaError && /no migration is registered/.test(error.message),
    )

    let ran = false
    const state = await ensureDataSchema(root, '0.0.1', {
      targetVersion: 1,
      migrations: [{
        from: 0,
        to: 1,
        name: 'test migration',
        run() { ran = true },
      }],
    })
    assert.equal(ran, true)
    assert.equal(state.version, 1)
    const backups = readdirSync(join(root, '.state', 'backups'))
    assert.ok(backups.length >= 1)
    assert.match(backups[0]!, /^data-schema-v0-/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
