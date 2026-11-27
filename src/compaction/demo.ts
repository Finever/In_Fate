import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCoreEvents } from '../core/registry.ts'
import { EventStore } from '../core/store.ts'
import { sessionStream } from '../core/streams.ts'
import { projectHistory } from '../projections/history.ts'
import { FileSpillStore, SpillPolicy } from '../tools/spill.ts'
import { TokenEstimator } from './estimate.ts'
import { compactIfNeeded } from './fold.ts'
import { DEFAULT_COMPACTION } from './types.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-compaction-'))
const store = new EventStore(join(dir, 'session.jsonl'))
const stream = sessionStream('s1')
const append = (actor: string, type: string, payload: Record<string, unknown>): void => {
  store.append({ stream, actor, type, payload })
}

for (let index = 0; index < 20; index += 1) {
  append('user', 'message.user', { text: `问题 ${index}` })
  append('agent', 'message.assistant', { text: `回答 ${index}` })
}

const estimator = new TokenEstimator()
const config = {
  ...DEFAULT_COMPACTION,
  triggerAt: 0.01,
  keepRecentTurns: 3,
  keepRecentTokenRatio: 0.001,
  pruneThresholdBytes: 1024,
  prunePreviewChars: 80,
}

const spill = new SpillPolicy(new FileSpillStore(join(dir, 'spill')), 1024, 80)

append('tool', 'tool.result', {
  callId: 'c-big',
  text: 'x'.repeat(8000),
})

const first = await compactIfNeeded({
  store,
  stream,
  config,
  estimator,
  contextWindow: 4000,
  system: '',
  tools: [],
  messages: projectHistory(store.read()),
  spill,
})

console.log('first compaction:', first?.anchor.fromEventId.slice(0, 8), '..', first?.anchor.toEventId.slice(0, 8), 'folded=', first?.stats.foldedCount, 'pruned=', first?.stats.prunedCount)
console.log('original events still there:', store.read().length)
console.log('summary goal:', first?.summary.goal)

const projected = projectHistory(store.read())
console.log('projected messages:', projected.length)
console.log('first projected:', JSON.stringify(projected[0]).slice(0, 220))

// 再追加一段，验证链尾与锚点扩展
for (let index = 20; index < 30; index += 1) {
  append('user', 'message.user', { text: `后续问题 ${index}` })
  append('agent', 'message.assistant', { text: `后续回答 ${index}` })
}

const second = await compactIfNeeded({
  store,
  stream,
  config,
  estimator,
  contextWindow: 4000,
  system: '',
  tools: [],
  messages: projectHistory(store.read()),
  spill,
})

console.log('second supersedes:', second?.supersedes ? 'yes' : 'no')
console.log('second anchor extended:', second?.anchor.fromEventId === first?.anchor.fromEventId && second?.anchor.toEventId !== first?.anchor.toEventId)

const effective = projectHistory(store.read()).filter(message => message.role === 'system' && message.origin === 'compaction')
console.log('effective compaction messages:', effective.length)
