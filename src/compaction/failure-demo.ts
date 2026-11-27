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
import { DEFAULT_COMPACTION, type Summarizer } from './types.ts'

registerCoreEvents()

const dir = mkdtempSync(join(tmpdir(), 'if-compaction-fail-'))
const store = new EventStore(join(dir, 'session.jsonl'))
const stream = sessionStream('f1')
const append = (actor: string, type: string, payload: Record<string, unknown>): void => {
  store.append({ stream, actor, type, payload })
}

for (let index = 0; index < 20; index += 1) {
  append('user', 'message.user', { text: `问题 ${index}` })
  append('agent', 'message.assistant', { text: `回答 ${index}` })
}

append('tool', 'tool.result', { callId: 'a', text: 'A'.repeat(3000) })
append('tool', 'tool.result', { callId: 'b', text: 'B'.repeat(3000) })

const estimator = new TokenEstimator()
const spill = new SpillPolicy(new FileSpillStore(join(dir, 'spill')), 1024, 50)
const config = {
  ...DEFAULT_COMPACTION,
  triggerAt: 0.01,
  targetAt: 0.9,
  keepRecentTurns: 3,
  keepRecentTokenRatio: 0.001,
  minTurnsBetween: 5,
  pruneThresholdBytes: 1024,
  prunePreviewChars: 50,
}

let seenFactsChars = 0
const summarizer: Summarizer = async ({ facts }) => {
  seenFactsChars = Math.max(seenFactsChars, JSON.stringify(facts).length)
  return {
    goal: '测试目标',
    constraints: [],
    decisions: [],
    facts: [],
    failed: [],
    open: [],
  }
}

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
  summarizer,
  currentTurn: 1,
})

console.log('first:', first?.stats.foldedCount, 'pruned:', first?.stats.prunedCount)
console.log('facts limited:', seenFactsChars > 0 && seenFactsChars < 5000, seenFactsChars)
console.log('target reached:', (first?.stats.tokensAfter ?? Infinity) / (4000 * 0.8) <= config.targetAt)

const toolMessages = projectHistory(store.read()).filter(message => message.role === 'tool')
console.log('previews distinct:', toolMessages[0]?.content.slice(0, 8), toolMessages[1]?.content.slice(0, 8))

const cooled = await compactIfNeeded({
  store,
  stream,
  config,
  estimator,
  contextWindow: 4000,
  system: '',
  tools: [],
  messages: projectHistory(store.read()),
  currentTurn: 2,
})
console.log('cooling works:', cooled === null)
