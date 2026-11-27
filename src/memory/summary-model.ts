import type { ChatRequest } from '../model/chat.ts'
import { chatModel } from '../model/chat-model.ts'
import type { ResolvedModel } from '../model/registry.ts'
import type { HistoryMessage } from '../projections/history.ts'
import type {
  GeneratedEntrySummary,
  MemorySummaryGenerator,
} from './summary.ts'
import type { MemoryEntry } from './store.ts'

export interface ModelSummaryGeneratorOptions {
  readonly model: ResolvedModel
  readonly timeoutMs?: number
  readonly batchSize?: number
}

const SYSTEM = [
  '你是记忆摘要器。把用户给的记忆条目压成便于检索的短摘要。',
  '只输出 JSON，不要解释，不要 Markdown 围栏。',
  '不得编造原文没有的事实；保留人名、数字、否定词、条件、边界和未完成事项。',
  '每条摘要控制在 120 个汉字以内，标题不超过 30 个汉字。',
  '返回数组，每项形状：{"entryId":"...","title":"...","summary":"...","keywords":["..."]}。',
].join('\n')

function contentOf(entry: MemoryEntry): string {
  const quotes = (entry.quotes ?? []).map(quote => `原话：${quote.say}`).join('\n')
  return [
    `id: ${entry.id}`,
    `tag: ${entry.tag}`,
    entry.at ? `at: ${entry.at}` : '',
    entry.content.slice(0, 4_000),
    quotes.slice(0, 1_500),
  ].filter(Boolean).join('\n')
}

function parseGenerated(text: string): GeneratedEntrySummary[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const raw = (fenced ?? text).trim()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('summary model returned non-array JSON')
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
  if (!Array.isArray(parsed)) throw new Error('summary model returned non-array JSON')
  return parsed.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const value = item as Record<string, unknown>
    if (typeof value.entryId !== 'string' || typeof value.summary !== 'string') return []
    return [{
      entryId: value.entryId,
      title: typeof value.title === 'string' ? value.title : value.entryId,
      summary: value.summary,
      keywords: Array.isArray(value.keywords)
        ? value.keywords.filter((word): word is string => typeof word === 'string')
        : [],
    }]
  })
}

export class ModelSummaryGenerator implements MemorySummaryGenerator {
  readonly name: string
  private readonly model: ResolvedModel
  private readonly timeoutMs: number
  private readonly batchSize: number

  constructor(options: ModelSummaryGeneratorOptions) {
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.batchSize = Math.max(1, options.batchSize ?? 8)
    this.name = `model:${options.model.provider.id}/${options.model.model.id}:summary-v1`
  }

  async generateDocument(input: {
    readonly target: string
    readonly entries: readonly MemoryEntry[]
    readonly now: Date
  }): Promise<readonly GeneratedEntrySummary[]> {
    const out: GeneratedEntrySummary[] = []
    for (let offset = 0; offset < input.entries.length; offset += this.batchSize) {
      const batch = input.entries.slice(offset, offset + this.batchSize)
      const messages: HistoryMessage[] = [{
        role: 'user',
        origin: 'user',
        content: [{
          type: 'text',
          text: [
            `记忆文件：${input.target}`,
            '以下是需要摘要的条目：',
            ...batch.map(contentOf),
          ].join('\n\n'),
        }],
      }]
      const request: ChatRequest = {
        resolved: this.model,
        system: SYSTEM,
        messages,
        temperature: 0.2,
        maxTokens: Math.min(1_800, batch.length * 180 + 200),
        signal: AbortSignal.timeout(this.timeoutMs),
      }
      let text = ''
      for await (const event of chatModel(request)) {
        if (event.type === 'text') text += event.text
      }
      const parsed = parseGenerated(text)
      const allowed = new Set(batch.map(entry => entry.id))
      out.push(...parsed.filter(item => allowed.has(item.entryId)))
    }
    return out
  }
}
