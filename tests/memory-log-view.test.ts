import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listLogTree, readLogPage, searchLogs } from '../src/memory/log-view.ts'
import { generateIndex, writeIndex } from '../src/memory/index.ts'

function fixture(): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'if-log-view-'))
  mkdirSync(join(root, 'detail', 'test'), { recursive: true })
  writeFileSync(
    join(root, 'detail', 'test', 'notes.json'),
    `${JSON.stringify({
      project: 'test',
      filename: 'notes',
      introduction: '测试索引',
      entries: [{
        id: 'notes-0001',
        'rec-time': '2026-11-02 10:00',
        'rev-time': null,
        at: null,
        tag: '确信',
        content: '一条记忆',
      }],
    }, null, 2)}\n`,
    'utf8',
  )
  const dayDir = join(root, 'log', '2026', '11', '2026-11-02')
  mkdirSync(dayDir, { recursive: true })
  writeFileSync(join(dayDir, 'sess-1.jsonl'), [
    JSON.stringify({ _meta: 1, agentid: 'main', agent_name: '测试', session: 'sess-1', date: '2026-11-02', cwd: 'x', start: '10:00:00' }),
    JSON.stringify({ n: 1, who: '用户', type: 'turn-start', ts: '10:00:00' }),
    JSON.stringify({ n: 1, text: '你好', ts: '10:00:01' }),
    JSON.stringify({ n: 2, type: 'tool', call: 'read', hint: 'a.md', ts: '10:00:02' }),
    JSON.stringify({ n: 3, text: '第二条', ts: '10:00:03' }),
  ].join('\n') + '\n', 'utf8')
  return {
    root,
    close: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

test('日志树、分页与 jump 定位', () => {
  const ctx = fixture()
  try {
    const tree = listLogTree(ctx.root)
    assert.equal(tree.days.length, 1)
    assert.equal(tree.days[0]?.day, '2026-11-02')
    assert.equal(tree.days[0]?.files[0]?.sid, 'sess-1')

    const page = readLogPage(ctx.root, '2026-11-02', 'sess-1')
    assert.equal(page.total, 3)
    assert.equal(page.rows[0]?.body, '你好')
    assert.equal(page.rows[1]?.kind, 'tool')
    assert.match(page.rows[1]?.body ?? '', /read · a.md/)
    assert.equal(page.meta?.agent_name, '测试')

    const jumped = readLogPage(ctx.root, '2026-11-02', 'sess-1', { jumpN: 3 })
    assert.equal(jumped.focus, 2)
    assert.equal(jumped.rows[jumped.focus!]?.body, '第二条')
  } finally {
    ctx.close()
  }
})

test('日志全库搜索与索引生成', () => {
  const ctx = fixture()
  try {
    const result = searchLogs(ctx.root, '第二条')
    assert.equal(result.total, 1)
    assert.equal(result.hits[0]?.addr, '2026-11-02-sess-1-3')
    assert.equal(result.hits[0]?.who, '')

    const index = generateIndex({ memoryRoot: ctx.root })
    const detail = index.items.find(item => item.path === 'detail/test/notes.json')
    assert.ok(detail)
    assert.equal(detail?.n, 1)
    assert.equal(detail?.what, '测试索引')

    const written = writeIndex({ memoryRoot: ctx.root })
    assert.equal(written.items.some(item => item.path === 'detail/test/notes.json'), true)
  } finally {
    ctx.close()
  }
})
