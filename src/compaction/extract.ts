/**
 * 从被压区间抽事实：先抽骨架，摘要只在这个骨架上做。
 *
 * @module if/compaction/extract
 */

import type { Event } from '../core/events.ts'
import type { ExtractedFacts } from './types.ts'

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

export function extractFacts(events: readonly Event[]): ExtractedFacts {
  const users: string[] = []
  const system: string[] = []
  const assistant: string[] = []
  const calls = new Map<string, { name: string; args: string }>()
  const results = new Map<string, string>()
  const errors: { what: string; error: string }[] = []
  const tasks: { id: string; state: string; title: string }[] = []

  for (const event of events) {
    if (event.type === 'message.user') {
      users.push(clip(String(event.payload.text ?? ''), 800))
      continue
    }
    if (event.type === 'message.system') {
      system.push(clip(String(event.payload.text ?? ''), 400))
      continue
    }
    if (event.type === 'message.assistant') {
      assistant.push(clip(String(event.payload.text ?? ''), 500))
      continue
    }
    if (event.type === 'tool.call') {
      const id = String(event.payload.callId ?? event.id)
      calls.set(id, {
        name: String(event.payload.call ?? ''),
        args: clip(JSON.stringify(event.payload.args ?? {}), 200),
      })
      continue
    }
    if (event.type === 'tool.result') {
      const id = String(event.payload.callId ?? event.refs?.toolCall ?? '')
      const text = clip(String(event.payload.text ?? ''), 300)
      results.set(id, text)
      if (event.payload.isError) {
        errors.push({ what: calls.get(id)?.name ?? 'tool', error: text })
      }
      continue
    }
    if (event.type === 'task.created' || event.type === 'task.updated') {
      tasks.push({
        id: String(event.payload.taskId ?? event.refs?.task ?? ''),
        state: String(event.payload.status ?? event.type),
        title: String(event.payload.title ?? ''),
      })
    }
  }

  return {
    users,
    system,
    assistant,
    tools: [...calls.entries()].map(([id, call]) => ({
      name: call.name,
      args: call.args,
      result: results.get(id) ?? '',
    })),
    errors,
    tasks,
  }
}

/** 抽取式兜底摘要：不调用模型。 */
export function extractiveSummary(facts: ExtractedFacts) {
  return {
    goal: facts.users.at(-1)?.slice(0, 200) ?? '（未记录目标）',
    constraints: facts.users.filter(text => /不要|必须|只能|禁止/.test(text)).slice(0, 5),
    decisions: facts.assistant.slice(-5).map(text => ({ what: text.slice(0, 120), why: '' })),
    facts: [
      ...facts.system.slice(-5).map(text => `[系统] ${text.slice(0, 120)}`),
      ...facts.tools.slice(-8).map(tool => `${tool.name}: ${tool.result.slice(0, 120)}`),
    ],
    failed: facts.errors.slice(0, 5).map(error => ({
      tried: error.what,
      why_failed: error.error.slice(0, 120),
    })),
    open: facts.tasks.filter(task => task.state !== 'completed').map(task => `task ${task.id}: ${task.state}`),
  }
}
