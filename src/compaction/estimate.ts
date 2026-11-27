import type { ToolSpec } from '../model/types.ts'
import type { HistoryMessage } from '../projections/history.ts'

export class TokenEstimator {
  factor: number
  private samples: number

  constructor(initialFactor = 0.45) {
    this.factor = initialFactor
    this.samples = 0
  }

  /** 用一次真实 usage 校准。actualTokens 是请求的输入 token。 */
  observe(chars: number, actualTokens: number): void {
    if (chars <= 0 || actualTokens <= 0) return
    const observed = actualTokens / chars
    this.factor = (this.factor * this.samples + observed) / (this.samples + 1)
    this.samples += 1
  }

  estimate(text: string): number {
    return Math.ceil(text.length * this.factor)
  }

  estimateMessages(messages: readonly HistoryMessage[]): number {
    return this.estimate(JSON.stringify(messages))
  }

  estimateTools(tools: readonly ToolSpec[]): number {
    return this.estimate(JSON.stringify(tools))
  }
}

export interface PressureInput {
  readonly messages: readonly HistoryMessage[]
  readonly system: string
  readonly tools: readonly ToolSpec[]
  readonly contextWindow: number
  readonly maxOutputTokens?: number
}

export interface Pressure {
  readonly pressure: number
  readonly estimated: number
  readonly usable: number
  readonly reserved: number
}

/** 上下文压力：分子含 system 与工具 schema，分母扣掉输出预留。 */
export function pressureOf(input: PressureInput, estimator: TokenEstimator): Pressure {
  const reserved = Math.min(
    input.maxOutputTokens ?? input.contextWindow * 0.2,
    input.contextWindow * 0.2,
  )
  const usable = Math.max(1, input.contextWindow - reserved)
  const estimated =
    estimator.estimateMessages(input.messages) +
    estimator.estimate(input.system) +
    estimator.estimateTools(input.tools)

  return {
    pressure: estimated / usable,
    estimated,
    usable,
    reserved,
  }
}
