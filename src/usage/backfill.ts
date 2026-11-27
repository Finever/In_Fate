import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Event } from '../core/events.ts'
import type { UsageLedger } from './ledger.ts'

export interface BackfillResult {
  readonly skipped: boolean
  readonly sessions: number
  readonly turns: number
  readonly inserted: number
  readonly errors: number
  readonly doneAt?: string
}

export interface BackfillOptions {
  readonly force?: boolean
  readonly onProgress?: (state: { sessions: number; turns: number; inserted: number }) => void
}

function parseLine(line: string): Event | undefined {
  const text = line.trim()
  if (!text) return undefined
  try {
    const raw = JSON.parse(text) as Event
    return raw && typeof raw === 'object' && typeof raw.type === 'string' ? raw : undefined
  } catch {
    return undefined
  }
}

function payloadOf(event: Event): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>
}

export async function backfillUsage(
  dataRoot: string,
  ledger: UsageLedger,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  if (!options.force && ledger.meta('backfill_done') === '1') {
    return {
      skipped: true,
      sessions: 0,
      turns: 0,
      inserted: 0,
      errors: 0,
      ...(ledger.meta('backfill_at') ? { doneAt: ledger.meta('backfill_at')! } : {}),
    }
  }

  const dir = join(dataRoot, 'sessions')
  if (!existsSync(dir)) {
    const doneAt = new Date().toISOString()
    ledger.setMeta('backfill_done', '1')
    ledger.setMeta('backfill_at', doneAt)
    return { skipped: false, sessions: 0, turns: 0, inserted: 0, errors: 0, doneAt }
  }

  let sessions = 0
  let turns = 0
  let inserted = 0
  let errors = 0

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.slice(0, -'.jsonl'.length)
    const file = join(dir, name)
    let turnIndex = 0
    let agentId: string | undefined
    let source: 'user' | 'agent' | 'unknown' = 'unknown'

    const reader = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    try {
      for await (const line of reader) {
        const event = parseLine(line)
        if (!event) continue
        if (event.type === 'session.created') {
          const payload = payloadOf(event)
          agentId = typeof payload.agentId === 'string' && payload.agentId
            ? payload.agentId
            : undefined
          const createdBy = typeof payload.createdBy === 'string' ? payload.createdBy : ''
          source = payload.kind === 'agent' || createdBy === 'agent' || createdBy.startsWith('agent:')
            ? 'agent'
            : 'user'
          continue
        }
        if (event.type === 'turn.completed') {
          turnIndex += 1
          turns += 1
          const enriched: Event = {
            ...event,
            payload: {
              ...event.payload,
              turn: turnIndex,
              ...(agentId ? { agentId } : {}),
              ...(source !== 'unknown' ? { source } : {}),
            },
          }
          try {
            if (ledger.recordEvent(enriched)) inserted += 1
          } catch {
            errors += 1
          }
          continue
        }
        if (event.type === 'usage.recorded') {
          try {
            if (ledger.recordEvent(event)) inserted += 1
          } catch {
            errors += 1
          }
        }
      }
    } catch {
      errors += 1
    } finally {
      reader.close()
    }
    sessions += 1
    options.onProgress?.({ sessions, turns, inserted })
  }

  const doneAt = new Date().toISOString()
  ledger.setMeta('backfill_done', '1')
  ledger.setMeta('backfill_at', doneAt)
  return { skipped: false, sessions, turns, inserted, errors, doneAt }
}
