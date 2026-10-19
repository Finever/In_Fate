/**
 * 归档游标失败注入：在事件文件前部插入一条事件，确认不重复归档。
 *
 * @module if/projections/archiver-demo
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProfile } from '../config/profile.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { userTurnPolicy } from '../turn/policy.ts'
import { archiveSession } from './archiver.ts'
import { memoryLogProjection } from './memory-log.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-archive-'))
const sessionId = 'arc-1'
const file = join(dir, 'session.jsonl')
const store = new EventStore(file)
const stream = sessionStream(sessionId)
const append = (actor: string, type: string, payload: Record<string, unknown>): void => {
  store.append({ stream, actor, type, payload })
}

append('user', 'message.user', { text: '一' })
append('agent', 'message.assistant', { text: '一答' })
append('user', 'message.user', { text: '二' })
append('agent', 'message.assistant', { text: '二答' })

const profile = { ...defaultProfile(), memoryLogRoot: join(dir, 'log') }
const options = {
  store,
  profile,
  projections: [memoryLogProjection],
  policy: userTurnPolicy,
  sessionId,
  stateDir: join(dir, 'archive-state'),
}

console.log('first archive lines:', archiveSession(options))

// 模拟文件前部被插入一条事件：行号会错位，事件 id 游标不会。
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const inserted = JSON.stringify({
  v: 1,
  id: 'inserted-before-cursor',
  ts: new Date().toISOString(),
  stream,
  actor: 'system',
  type: 'session.created',
  payload: {},
})
writeFileSync(file, [inserted, ...lines].join('\n') + '\n', 'utf8')

append('user', 'message.user', { text: '三' })
append('agent', 'message.assistant', { text: '三答' })

console.log('second archive lines:', archiveSession(options))

const logDir = join(dir, 'log')
const day = readdirSync(join(logDir, '2026', '10')).find(name => name.startsWith('2026-'))
const logFile = join(logDir, '2026', '10', day ?? '', `${sessionId}.jsonl`)
const logLines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
console.log('total memory log lines:', logLines.length)
