import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { appendLog, buildTurn, clock, logPath } from '../memory/log.ts'
import { createRecallTool } from './builtin/recall.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-recall-'))
const memoryRoot = join(dir, 'memory')
const store = new EventStore(join(dir, 'session.jsonl'))
const stream = sessionStream('r1')

const first = store.append({
  stream,
  actor: 'user',
  type: 'message.user',
  payload: { text: '原话一' },
})
const second = store.append({
  stream,
  actor: 'agent',
  type: 'message.assistant',
  payload: { text: '回答一' },
})

const now = new Date()
const file = logPath(memoryRoot, now, 'r1')
const t = clock(now)
appendLog(file, [
  { n: 1, who: 'Demo User', ts: t, text: '原话一' },
  ...buildTurn(1, 'Demo Agent', [{ type: 'text', p: '回答一' }], t),
])

const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const tool = createRecallTool(store, { memoryLogRoot: memoryRoot })

const byLog = await tool.run({ logAddr: `${date}-r1-1` }, {} as never)
const byEvents = await tool.run(
  { fromEventId: first.id, toEventId: second.id },
  {} as never,
)

console.log('logAddr recall:', (byLog.text ?? '').includes('原话一'), byLog.structured)
console.log('event recall:', (byEvents.text ?? '').includes('原话一'), byEvents.structured)
