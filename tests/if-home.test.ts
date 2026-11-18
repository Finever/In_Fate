import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveIfHome } from '../src/app/home.ts'

test('IF_HOME 优先，IF_PORTABLE 回退到 cwd', () => {
  const explicit = join(tmpdir(), 'if-home-explicit')
  assert.equal(
    resolveIfHome({ IF_HOME: explicit } as NodeJS.ProcessEnv),
    resolve(explicit),
  )
  assert.equal(
    resolveIfHome({ IF_HOME: '', IF_PORTABLE: '1' } as NodeJS.ProcessEnv),
    resolve(process.cwd()),
  )
  assert.equal(resolveIfHome({} as NodeJS.ProcessEnv), undefined)
})
