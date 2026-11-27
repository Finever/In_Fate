import type { Event, NewEvent } from '../core/events.ts'
import type { SessionWriter } from '../core/session-writer.ts'
import type { EventStore } from '../core/store.ts'
import { agentStream } from '../core/streams.ts'

const TERMINAL = new Set([
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'agent.interrupted',
])

export function repairAgentStream(store: EventStore, writer?: SessionWriter): boolean {
  const events = store.read()
  if (events.length === 0) return false
  if (events.some(event => TERMINAL.has(event.type))) return false

  const started = events.find(event =>
    event.type === 'agent.requested' || event.type === 'agent.started')
  if (!started) return false

  const requestId = String(started.payload.requestId ?? '')
  if (!requestId) return false
  const preset = String(started.payload.preset ?? '')

  const append = (input: NewEvent): Event =>
    writer ? writer.append(input) : store.append(input)

  append({
    stream: agentStream(requestId),
    actor: 'agent',
    type: 'agent.interrupted',
    payload: {
      requestId,
      preset,
      summary: '',
      artifacts: [],
      usage: { input: 0, output: 0, cacheRead: 0 },
      steps: 0,
      error: 'process restarted',
    },
  })

  if (writer) writer.flush()
  else store.flush()
  return true
}
