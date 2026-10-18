/**
 * 事件存储：只追加的 JSONL。
 *
 * 这里只有原语：追加、读取、按行游标。聚合、投影、轮次都不属于存储层。
 * 行号是唯一可靠的顺序；事件 id 是 UUID，无序。
 *
 * @module if/core/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ENVELOPE_VERSION, type Event, type NewEvent } from './events.ts'
import { getEventSpec } from './registry.ts'

/** 存储层的失败。调用方应当显式处理，不要静默吞掉。 */
export class IfStorageError extends Error {
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'IfStorageError'
    this.cause = cause
  }
}

/** 读到坏行：fail-closed，不猜、不跳过。 */
export class IfCorruptionError extends IfStorageError {
  readonly file: string
  readonly line: number

  constructor(file: string, line: number) {
    super(`corrupt event log: ${file}:${line}`)
    this.name = 'IfCorruptionError'
    this.file = file
    this.line = line
  }
}

export class EventStore {
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** 追加一条事件。注册过的类型先过校验器。 */
  append(input: NewEvent): Event {
    const spec = getEventSpec(input.type)
    spec?.validate?.(input.payload)

    const event: Event = {
      v: ENVELOPE_VERSION,
      ...(spec ? { tv: spec.version } : {}),
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...input,
    }

    mkdirSync(dirname(this.file), { recursive: true })
    try {
      appendFileSync(this.file, JSON.stringify(event) + '\n', { encoding: 'utf8' })
    } catch (error) {
      throw new IfStorageError(`append failed: ${this.file}`, error)
    }
    return event
  }

  /** 读全部事件。 */
  read(): readonly Event[] {
    return this.readFrom(0)
  }

  /** 从第 line 行开始读（0 起）。游标用它，不用事件 id。 */
  readFrom(line: number): readonly Event[] {
    if (!existsSync(this.file)) return []
    const raw = readFileSync(this.file, 'utf8')
    const lines = raw.split('\n')
    const out: Event[] = []

    for (let i = line; i < lines.length; i += 1) {
      const text = lines[i].trim()
      if (!text) continue
      try {
        out.push(JSON.parse(text) as Event)
      } catch {
        throw new IfCorruptionError(this.file, i + 1)
      }
    }
    return out
  }

  /** 当前行数（含空行），用于游标推进。 */
  lineCount(): number {
    if (!existsSync(this.file)) return 0
    return readFileSync(this.file, 'utf8').split('\n').length - 1
  }
}
