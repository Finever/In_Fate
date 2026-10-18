/**
 * 旧入口的薄适配层。实现已挪到 projections/archiver.ts，这里只保留原来的调用形状。
 *
 * 与旧版的区别：多了 profile 参数——路径、时区、参与者都从配置来，不再写死。
 * 新代码请直接用 archiveSession。
 *
 * @module if/archive
 */

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
