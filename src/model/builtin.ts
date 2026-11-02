/**
 * 内置模型服务商：只给端点，不猜模型。
 *
 * 这些 provider 会并入 registry，出现在设置里；模型列表由用户用
 * 「读取模型列表」（GET /models）或手动添加，不再写死默认模型。
 * 没有对应 API key 时只是不可用，不会阻止其它 provider。
 *
 * @module if/model/builtin
 */

import type { ProviderConfig } from './types.ts'

const openaiCompatible = (baseUrl: string): ProviderConfig['endpoints'] => ({
  'openai-chat-completions': {
    adapterFamily: 'openai-chat-completions',
    baseUrl,
  },
})

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 官方 API（OpenAI 兼容）',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://api.deepseek.com/v1'),
    models: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI 官方 API',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://api.openai.com/v1'),
    models: [],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    description: '智谱开放平台（OpenAI 兼容）',
    apiKeyEnv: 'ZHIPU_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://open.bigmodel.cn/api/paas/v4'),
    models: [],
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    description: 'Moonshot 开放平台（OpenAI 兼容）',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://api.moonshot.cn/v1'),
    models: [],
  },
  {
    id: 'qwen',
    name: '阿里云百炼 / Qwen',
    description: 'DashScope OpenAI 兼容端点',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter 聚合端点（OpenAI 兼容）',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://openrouter.ai/api/v1'),
    models: [],
  },
]
