/**
 * 模型来源与模型卡：来源是配置，不是代码。
 *
 * 一个来源可以有多个端点（同厂商不同协议），模型卡声明能力与预算。
 * 密钥只走环境变量或运行时注入，不写进配置文件。
 *
 * @module if/model/types
 */

export type ApiFamily =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generate-content'
  | (string & {})

export interface EndpointConfig {
  /** 适配器家族；决定用哪个协议实现 */
  readonly adapterFamily: string
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
  readonly reasoningFormat?: string
}

export interface PriceRate {
  readonly currency: string
  readonly perMillionTokens: number
}

/** 低谷时段；按本地墙钟时间判断，end <= start 表示跨午夜。 */
export interface PricingWindow {
  /** 0=周日 … 6=周六；不填=每天。指窗口开始那天。 */
  readonly days?: readonly number[]
  /** 本地时间 HH:mm */
  readonly start: string
  /** 本地时间 HH:mm；结束开区间 */
  readonly end: string
}

export interface ModelPriceSet {
  readonly input?: PriceRate
  readonly output?: PriceRate
  readonly cacheRead?: PriceRate
  readonly cacheWrite?: PriceRate
}

export interface ModelPricing extends ModelPriceSet {
  /** 低谷价；缺某项时回退到上面的标准价。 */
  readonly offPeak?: ModelPriceSet & {
    readonly windows: readonly PricingWindow[]
  }
}

export interface ModelCard {
  readonly id: string
  /** 真正发给 API 的模型名；不填就用 id */
  readonly apiModelId?: string
  readonly name?: string
  /** function-call / reasoning / image-recognition / structured-output */
  readonly capabilities?: readonly string[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly inputModalities?: readonly string[]
  readonly outputModalities?: readonly string[]
  readonly pricing?: ModelPricing
}

export interface ProviderConfig {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly defaultChatEndpoint?: ApiFamily
  readonly endpoints: Readonly<Record<string, EndpointConfig>>
  readonly models: readonly ModelCard[]
  /** 直接给密钥（仅内存配置用） */
  readonly apiKey?: string
  /** 从环境变量读密钥 */
  readonly apiKeyEnv?: string
}

export interface ToolSpec {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
}

export type ModelEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: 'usage'; readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number }
  | { readonly type: 'done' }
