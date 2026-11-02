/**
 * 常用上下文段。段是注册项——用不用、优先级多少，由装配方决定。
 *
 * @module if/context/sections
 */

import { readSources, type MemorySource } from '../memory/sources.ts'
import type { ContextSection } from './types.ts'

/** 固定文本，通常放请求头。 */
export function staticSection(id: string, text: string, priority = 100): ContextSection {
  return {
    id,
    layer: 'stable',
    priority,
    render: () => ({ text }),
  }
}

/** 记忆源：文件在渲染时读，缺文件跳过。 */
export function memorySection(
  id: string,
  sources: readonly MemorySource[],
  priority = 90,
): ContextSection {
  return {
    id,
    layer: 'stable',
    priority,
    render: () => {
      const chunks = readSources(sources)
      if (chunks.length === 0) return
      return {
        text: chunks.map(chunk => `<!-- ${chunk.id} -->\n${chunk.text}`).join('\n\n'),
        meta: { sources: chunks.map(chunk => ({ id: chunk.id, bytes: chunk.bytes, digest: chunk.digest })) },
      }
    },
  }
}

/** 按会话解析记忆源：每个主 agent 的身份文件不同，渲染时再查。 */
export function sessionMemorySection(
  id: string,
  resolveSources: (sessionId: string) => readonly MemorySource[],
  priority = 90,
): ContextSection {
  return {
    id,
    layer: 'stable',
    priority,
    render: (context) => {
      const chunks = readSources(resolveSources(context.sessionId))
      if (chunks.length === 0) return
      return {
        text: chunks.map(chunk => `<!-- ${chunk.id} -->\n${chunk.text}`).join('\n\n'),
        meta: { sources: chunks.map(chunk => ({ id: chunk.id, bytes: chunk.bytes, digest: chunk.digest })) },
      }
    },
  }
}

/** 当前时间：ephemeral，必进，永远放在最后。 */
export function timeSection(priority = 100): ContextSection {
  return {
    id: 'now',
    layer: 'ephemeral',
    priority,
    render: (context) => {
      const text = new Intl.DateTimeFormat('zh-CN', {
        timeZone: context.profile.timeZone,
        dateStyle: 'full',
        timeStyle: 'medium',
      }).format(context.now)
      return { text }
    },
  }
}
