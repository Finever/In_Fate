import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCoreEvents } from './registry.ts'
import { EventStore } from './store.ts'
import { sessionStream } from './streams.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-store-'))
const file = join(dir, 'session.jsonl')
const store = new EventStore(file, { segmentMaxBytes: 500 })
const stream = sessionStream('s1')

const events = []
for (let index = 0; index < 20; index += 1) {
  events.push(store.append({
    stream,
    actor: 'user',
    type: 'message.user',
    payload: { text: `消息 ${index} ${'x'.repeat(60)}` },
  }))
}

const files = readdirSync(dir).filter(name => name.startsWith('session.jsonl'))
console.log('segments:', files.length, files.sort().join(', '))
console.log('read all:', store.read().length)
console.log('since #9:', store.readSince(events[9].id).length)
