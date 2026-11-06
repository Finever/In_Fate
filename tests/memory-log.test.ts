import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { MemoryLogService } from '../src/memory/internal-log.ts'
import { localLogStamp, logPathForDay, readLog } from '../src/memory/log.ts'
import { ensureMemoryLayout } from '../src/memory/root.ts'

function newStore(dir: string): EventStore {
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return new EventStore(join(dir, 'sessions', 'sess-1.jsonl'))
}

function newService(memoryRoot: string): MemoryLogService {
  return new MemoryLogService({
    memoryRoot,
    timeZone: 'Asia/Shanghai',
    userName: '触久',
    metaFor: () => ({ agentId: 'main', agentName: '未凉', cwd: 'C:/work' }),
  })
}

function appendTurn(
  store: EventStore,
  user: string,
  assistant: string,
): void {
  const stream = 'session:sess-1'
  store.append({
    stream,
    actor: 'user',
    type: 'message.user',
    payload: { text: user },
  })
  store.append({
    stream,
    actor: 'agent',
    type: 'message.assistant',
    payload: { text: assistant },
  })
  store.append({
    stream,
    actor: 'tool',
    type: 'tool.call',
    payload: { call: 'read', args: { file_path: 'notes.md' } },
  })
  store.append({
    stream,
    actor: 'system',
    type: 'turn.completed',
    payload: { status: 'completed' },
  })
}

test('内部 log：从事件流写 hook 兼容行，重启不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-memory-log-'))
  const memoryRoot = join(dir, 'memory')
  ensureMemoryLayout(memoryRoot)
  const store = newStore(dir)
  const service = newService(memoryRoot)
  try {
    service.attach('sess-1', store)
    appendTurn(store, '第一问', '第一答')
    await service.flush()

    const stamp = localLogStamp(new Date(), 'Asia/Shanghai')
    const path = logPathForDay(memoryRoot, stamp, 'sess-1')
    assert.equal(existsSync(path), true)
    const rows = readLog(path)
    assert.equal(rows[0]?._meta, 1)
    assert.equal(rows[0]?.agentid, 'main')
    assert.equal(rows[0]?.agent_name, '未凉')
    assert.deepEqual(
      rows.slice(1).map(row => ({
        n: row.n,
        who: row.who,
        type: row.type,
        text: row.text,
        p: row.p,
        call: row.call,
        hint: row.hint,
        src: Boolean(row.src),
      })),
      [
        { n: 1, who: '触久', type: undefined, text: '第一问', p: undefined, call: undefined, hint: undefined, src: true },
        { n: 2, who: '未凉', type: 'turn-start', text: undefined, p: undefined, call: undefined, hint: undefined, src: true },
        { n: 2, who: undefined, type: 'text', text: undefined, p: '第一答', call: undefined, hint: undefined, src: true },
        { n: 2, who: undefined, type: 'tool', text: undefined, p: undefined, call: 'read', hint: 'notes.md', src: true },
        { n: 2, who: undefined, type: 'turn-end', text: undefined, p: undefined, call: undefined, hint: undefined, src: false },
      ],
    )

    appendTurn(store, '第二问', '第二答')
    await service.flush()
    assert.equal(readLog(path).length, 11)

    // 模拟重启：游标还在就不重复；游标丢了也要靠 src 去重。
    const restarted = newService(memoryRoot)
    restarted.attach('sess-1', store)
    await restarted.flush()
    assert.equal(readLog(path).length, 11)

    rmSync(join(memoryRoot, '.state', 'log-cursors.json'), { force: true })
    const rebuilt = newService(memoryRoot)
    rebuilt.attach('sess-1', store)
    await rebuilt.flush()
    assert.equal(readLog(path).length, 11)
  } finally {
    await service.flush()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
