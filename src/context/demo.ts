import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProfile } from '../config/profile.ts'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { defaultSources } from '../memory/sources.ts'
import { projectHistory } from '../projections/history.ts'
import { renderContext } from './pipeline.ts'
import { memorySection, staticSection, timeSection } from './sections.ts'

registerCoreEvents()

const profile = {
  ...defaultProfile(),
  principals: {
    user: { id: 'u1', name: '示例用户' },
    agents: [{ id: 'a1', name: '示例助手', role: 'main' }],
  },
}

const dir = mkdtempSync(join(tmpdir(), 'if-context-'))
const store = new EventStore(join(dir, 'session.jsonl'))
const stream = sessionStream('c1')
const append = (actor: string, type: string, payload: Record<string, unknown>): void => {
  store.append({ stream, actor, type, payload })
}

append('user', 'message.user', { text: '你好' })
append('agent', 'message.assistant', { text: '我在' })

const history = projectHistory(store.read())
const agentDir = join(process.cwd(), 'agent')

const sections = [
  staticSection('header', '你是示例助手。'),
  memorySection('memory', defaultSources(agentDir), 90),
  timeSection(),
]

const options = {
  sections,
  history,
  profile,
  sessionId: 'c1',
  turn: 1,
  now: new Date('2026-10-18T12:00:00Z'),
}

const first = renderContext(options)
const second = renderContext(options)

console.log('system bytes:', Buffer.byteLength(first.system, 'utf8'))
console.log('messages:', first.messages.length)
console.log('injections:', first.injections.map(item => `${item.id}:${item.layer}:${item.bytes}${item.dropped ? '(dropped)' : ''}`).join(', '))
console.log('prefixHash:', first.prefixHash)
console.log('两次一致:', first.prefixHash === second.prefixHash)
console.log('overBudget:', first.overBudget)
console.log('最后一条:', JSON.stringify(first.messages.at(-1)))
