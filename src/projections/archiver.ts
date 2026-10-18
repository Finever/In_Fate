/**
 * 归档器：事件流的消费者。
 *
 * 只读事件、写别处，永远不往事件流里回写。游标用“已消费的行数”，
 * 重启续写不重复；未闭合的轮留到下次。
 *
 * @module if/projections/archiver
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Event } from '../core/events.ts'
import type { EventStore } from '../core/store.ts'
import type { Profile } from '../config/profile.ts'
import type { TurnPolicy } from '../turn/policy.ts'
import { groupTurns } from '../turn/policy.ts'
import type { Projection } from './types.ts'

export interface ArchiveState {
  readonly consumedLines: number
  readonly turn: number
}

export interface ProjectionResult<T> {
  readonly turn: number
  readonly lines: readonly T[]
}

const EMPTY_STATE: ArchiveState = { consumedLines: 0, turn: 0 }

function loadState(file: string): ArchiveState {
  if (!existsSync(file)) return EMPTY_STATE
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ArchiveState>
  return {
    consumedLines: raw.consumedLines ?? 0,
    turn: raw.turn ?? 0,
  }
}

function saveState(file: string, state: ArchiveState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state), 'utf8')
}

/** 把事件按轮投影成行。纯函数，不落盘。 */
export function projectEvents<T>(
  events: readonly Event[],
  profile: Profile,
  projections: readonly Projection<T>[],
  policy: TurnPolicy,
  sessionId: string,
  startTurn: number,
): ProjectionResult<T> & { readonly consumed: number } {
  const { closed, consumed } = groupTurns(events, policy)
  let turn = startTurn
  const lines: T[] = []

  for (const group of closed) {
    turn += 1
    const context = { profile, sessionId, turn, now: new Date() }
    for (const event of group) {
      for (const projection of projections) {
        if (!projection.handles(event.type)) continue
        const output = projection.map(event, context)
        if (Array.isArray(output)) lines.push(...output)
        else if (output !== undefined) lines.push(output as T)
      }
    }
  }

  return { turn, lines, consumed }
}

/** 记忆库 log 的落点，由 profile 决定；没配就不写。 */
function memoryLogPath(profile: Profile, sessionId: string, now: Date): string | undefined {
  if (!profile.memoryLogRoot) return undefined
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: profile.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value
      return acc
    }, {})

  return join(profile.memoryLogRoot, parts.year, parts.month, `${parts.year}-${parts.month}-${parts.day}`, `${sessionId}.jsonl`)
}

export interface ArchiveOptions<T> {
  readonly store: EventStore
  readonly profile: Profile
  readonly projections: readonly Projection<T>[]
  readonly policy: TurnPolicy
  readonly sessionId: string
  /** 状态目录；默认 dataRoot/archive */
  readonly stateDir?: string
}

/** 增量归档一次。返回这次写出的行数。 */
export function archiveSession<T>(options: ArchiveOptions<T>): number {
  const { store, profile, projections, policy, sessionId } = options
  if (!profile.memoryLogRoot) return 0

  const stateFile = join(options.stateDir ?? join(profile.dataRoot, 'archive'), `${sessionId}.state.json`)
  const state = loadState(stateFile)
  const fresh = store.readFrom(state.consumedLines)

  const result = projectEvents(fresh, profile, projections, policy, sessionId, state.turn)
  if (result.lines.length === 0) {
    // 即使没有闭合轮，也把状态写回，避免重复读同一段
    saveState(stateFile, state)
    return 0
  }

  const target = memoryLogPath(profile, sessionId, new Date())
  if (!target) return 0
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, result.lines.map(line => JSON.stringify(line)).join('\n') + '\n', { encoding: 'utf8' })

  saveState(stateFile, {
    consumedLines: state.consumedLines + result.consumed,
    turn: result.turn,
  })

  return result.lines.length
}
