/**
 * 上下文管线：stable → dynamic → ephemeral。
 *
 * stable 只拼接、不裁剪；dynamic 按优先级填，超预算丢低的；
 * ephemeral 必进。历史整段放在 stable 之后、dynamic 之前。
 * prefixHash 只对 stable 段做——它是缓存前缀的证据。
 *
 * @module if/context/pipeline
 */

import { createHash } from 'node:crypto'
import type { Profile } from '../config/profile.ts'
import type { HistoryMessage } from '../projections/history.ts'
import type { ContextLayer, ContextSection, PipelineContext } from './types.ts'

export interface InjectionRecord {
  readonly id: string
  readonly layer: ContextLayer
  readonly bytes: number
  readonly dropped: boolean
}

export interface RenderedContext {
  /** stable 段拼成的 system 文本 */
  readonly system: string
  /** 历史 + dynamic/ephemeral 注入 */
  readonly messages: readonly HistoryMessage[]
  readonly injections: readonly InjectionRecord[]
  readonly bytes: number
  /** stable 前缀的 sha1；两轮一致说明缓存前缀没断 */
  readonly prefixHash: string
  readonly overBudget: boolean
}

export interface RenderOptions {
  readonly sections: readonly ContextSection[]
  readonly history: readonly HistoryMessage[]
  readonly profile: Profile
  readonly sessionId: string
  readonly turn: number
  readonly now: Date
  /** 总字节预算，默认 128 KiB */
  readonly maxBytes?: number
}

const DEFAULT_MAX_BYTES = 128 * 1024

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function toSystemMessage(text: string): HistoryMessage {
  return {
    role: 'system',
    content: [{ type: 'text', text }],
    origin: 'agent',
  }
}

export function renderContext(options: RenderOptions): RenderedContext {
  const context: PipelineContext = {
    profile: options.profile,
    sessionId: options.sessionId,
    turn: options.turn,
    now: options.now,
    history: options.history,
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  const grouped = new Map<ContextLayer, ContextSection[]>()
  for (const section of options.sections) {
    const list = grouped.get(section.layer) ?? []
    list.push(section)
    grouped.set(section.layer, list)
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => b.priority - a.priority)
  }

  const injections: InjectionRecord[] = []
  const stableParts: string[] = []

  // stable：全收，不裁。超预算只标记，不丢。
  for (const section of grouped.get('stable') ?? []) {
    const output = section.render(context)
    if (!output?.text) continue
    stableParts.push(output.text)
    injections.push({
      id: section.id,
      layer: 'stable',
      bytes: bytesOf(output.text),
      dropped: false,
    })
  }

  const system = stableParts.join('\n\n---\n\n')
  let used = bytesOf(system)

  // dynamic：按优先级降序填；预算不够就丢这一条。
  const lateMessages: HistoryMessage[] = []
  for (const section of grouped.get('dynamic') ?? []) {
    const output = section.render(context)
    if (!output) continue
    const text = output.text ?? ''
    const bytes = bytesOf(text)

    if (text && used + bytes > maxBytes) {
      injections.push({ id: section.id, layer: 'dynamic', bytes, dropped: true })
      continue
    }

    if (text) {
      lateMessages.push(toSystemMessage(text))
      used += bytes
    }
    if (output.messages) {
      lateMessages.push(...output.messages)
      used += bytesOf(JSON.stringify(output.messages))
    }
    injections.push({ id: section.id, layer: 'dynamic', bytes, dropped: false })
  }

  // ephemeral：必进，不参与裁剪。
  for (const section of grouped.get('ephemeral') ?? []) {
    const output = section.render(context)
    if (!output) continue
    const text = output.text ?? ''
    if (text) {
      lateMessages.push(toSystemMessage(text))
      used += bytesOf(text)
    }
    if (output.messages) {
      lateMessages.push(...output.messages)
      used += bytesOf(JSON.stringify(output.messages))
    }
    injections.push({ id: section.id, layer: 'ephemeral', bytes: bytesOf(text), dropped: false })
  }

  const messages = [...options.history, ...lateMessages]
  const bytes = used + bytesOf(JSON.stringify(messages))
  const prefixHash = createHash('sha1').update(system, 'utf8').digest('hex')

  return {
    system,
    messages,
    injections,
    bytes,
    prefixHash,
    overBudget: used > maxBytes,
  }
}
