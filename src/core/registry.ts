/**
 * 事件类型注册表：加类型不改核心，只注册一条 spec。
 *
 * @module if/core/registry
 */

import type { CoreEventType, EventType } from './events.ts'

/** 一种事件类型的定义。版本独立于 envelope 版本。 */
export interface EventSpec {
  readonly type: EventType
  readonly version: number
  /** 写入前跑；抛错即拒绝写入。 */
  readonly validate?: (payload: unknown) => void
}

const specs = new Map<string, EventSpec>()

/** 注册一种事件。重复注册直接报错，避免两个定义打架。 */
export function defineEvent(spec: EventSpec): void {
  if (specs.has(spec.type)) throw new Error(`event already defined: ${spec.type}`)
  specs.set(spec.type, spec)
}

export function getEventSpec(type: string): EventSpec | undefined {
  return specs.get(type)
}

export function listEventSpecs(): readonly EventSpec[] {
  return [...specs.values()]
}

/** 内置类型：没有校验器，先把版本钉成 1。 */
export function registerCoreEvents(): void {
  const core: CoreEventType[] = [
    'session.created',
    'message.user',
    'message.system',
    'message.assistant',
    'thoughts.segment',
    'tool.call',
    'tool.result',
    'task.created',
    'task.updated',
    'token.recorded',
    'context.injected',
  ]
  for (const type of core) {
    if (!specs.has(type)) defineEvent({ type, version: 1 })
  }
}
