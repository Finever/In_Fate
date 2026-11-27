import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderContext } from '../src/context/pipeline.ts'
import { sessionMemorySection, timeSection } from '../src/context/sections.ts'
import type { Profile } from '../src/config/profile.ts'

const profile: Profile = {
  dataRoot: join(tmpdir(), 'if-context-profile'),
  timeZone: 'Asia/Shanghai',
  principals: {},
}

test('身份段带“当前人格优先”提示，时间段只给当前时间', () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-context-sections-'))
  try {
    const identity = join(dir, 'principle.md')
    writeFileSync(identity, '# 原则\n\n我是测试助手。\n', 'utf8')
    const rendered = renderContext({
      sections: [
        sessionMemorySection('memory', () => [{
          id: 'principle',
          path: identity,
          role: 'identity',
          layer: 'stable',
        }]),
        timeSection(),
      ],
      history: [],
      profile,
      sessionId: 's',
      turn: 1,
      now: new Date('2026-11-20T05:35:00.000Z'),
    })
    assert.match(rendered.system, /当前人格文件/)
    assert.match(rendered.system, /我是测试助手/)
    const ephemeral = JSON.stringify(rendered.messages)
    assert.match(ephemeral, /当前时间/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})