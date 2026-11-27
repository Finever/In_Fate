import { EventStore } from './core/store.ts'
import type { Profile } from './config/profile.ts'
import { archiveSession } from './projections/archiver.ts'
import { memoryLogProjection } from './projections/memory-log.ts'
import { userTurnPolicy } from './turn/policy.ts'

export function archive(sessionFile: string, sessionId: string, profile: Profile): number {
  return archiveSession({
    store: new EventStore(sessionFile),
    profile,
    projections: [memoryLogProjection],
    policy: userTurnPolicy,
    sessionId,
  })
}
