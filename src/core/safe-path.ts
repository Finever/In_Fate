import { isAbsolute, relative, resolve } from 'node:path'

export class IfPathError extends Error {
  readonly value: string

  constructor(message: string, value: string) {
    super(message)
    this.name = 'IfPathError'
    this.value = value
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/
const SPILL_REF = /^spill:([0-9a-f]{40})$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export function assertSafeSegment(value: string, label = 'segment'): string {
  if (
    !SAFE_SEGMENT.test(value)
    || value === '.'
    || value === '..'
    || /[. ]$/.test(value)
    || WINDOWS_RESERVED.test(value)
  ) {
    throw new IfPathError(`unsafe ${label}: ${JSON.stringify(value)}`, value)
  }
  return value
}

export function assertSafeSessionId(value: string): string {
  return assertSafeSegment(value, 'sessionId')
}

/** 取 spill ref 的哈希；不合法直接拒绝。 */
export function spillHash(ref: string): string {
  const match = SPILL_REF.exec(ref)
  if (!match) throw new IfPathError(`invalid spill ref: ${JSON.stringify(ref)}`, ref)
  return match[1]!
}

/** 目标必须落在 root 之下（或等于 root）。 */
export function assertWithin(root: string, target: string, label = 'path'): string {
  const rootAbs = resolve(root)
  const targetAbs = resolve(target)
  const rel = relative(rootAbs, targetAbs)

  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return targetAbs

  throw new IfPathError(`unsafe ${label} outside ${rootAbs}: ${targetAbs}`, target)
}
