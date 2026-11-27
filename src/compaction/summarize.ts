import { extractiveSummary } from './extract.ts'
import type { CompactionSummary, ExtractedFacts, Summarizer } from './types.ts'

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter(item => item.length > 0))]
}

export function mergeSummaries(
  previous: CompactionSummary | undefined,
  facts: ExtractedFacts,
): CompactionSummary {
  const base = extractiveSummary(facts)
  if (!previous) return base

  return {
    goal: base.goal || previous.goal,
    constraints: unique([...previous.constraints, ...base.constraints]).slice(0, 12),
    decisions: [...previous.decisions, ...base.decisions].slice(-12),
    facts: unique([...previous.facts, ...base.facts]).slice(-24),
    failed: [...previous.failed, ...base.failed].slice(-12),
    open: unique([...base.open, ...previous.open]).slice(-12),
  }
}

function parseSummary(text: string): CompactionSummary | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<CompactionSummary>
    if (typeof raw.goal !== 'string') return undefined
    return {
      goal: raw.goal,
      constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String) : [],
      decisions: Array.isArray(raw.decisions)
        ? raw.decisions.map(item => ({ what: String((item as { what?: unknown }).what ?? ''), why: String((item as { why?: unknown }).why ?? '') }))
        : [],
      facts: Array.isArray(raw.facts) ? raw.facts.map(String) : [],
      failed: Array.isArray(raw.failed)
        ? raw.failed.map(item => ({ tried: String((item as { tried?: unknown }).tried ?? ''), why_failed: String((item as { why_failed?: unknown }).why_failed ?? '') }))
        : [],
      open: Array.isArray(raw.open) ? raw.open.map(String) : [],
    }
  } catch {
    return undefined
  }
}

/** 用模型写摘要；解析失败自动退回合并式。 */
export function createModelSummarizer(
  callModel: (prompt: string) => Promise<string>,
): Summarizer {
  return async ({ previous, facts }) => {
    const prompt = [
      '你在压缩一段对话历史。只输出 JSON，不要解释。',
      '必须保留：目标、硬约束、已做决定、可验证事实、失败的尝试、未完成事项。',
      previous ? `上一份摘要：${JSON.stringify(previous)}` : '这是第一次压缩。',
      `本段抽取事实：${JSON.stringify(facts)}`,
      '输出结构：{"goal":string,"constraints":string[],"decisions":[{"what":string,"why":string}],"facts":string[],"failed":[{"tried":string,"why_failed":string}],"open":string[]}',
    ].join('\n')

    const text = await callModel(prompt)
    return parseSummary(text) ?? mergeSummaries(previous, facts)
  }
}
