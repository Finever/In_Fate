/**
 * 内置模型服务商：只提供 OpenAI 兼容端点，不替用户写死 key。
 *
 * 这些 provider 会并入 registry，出现在设置里；配置文件和 key 仍然由用户决定。
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
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: ['function-call', 'reasoning'],
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI 官方 API',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://api.openai.com/v1'),
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: ['function-call', 'reasoning', 'image-recognition', 'structured-output'],
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: ['function-call', 'reasoning', 'image-recognition', 'structured-output'],
      },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    description: '智谱开放平台（OpenAI 兼容）',
    apiKeyEnv: 'ZHIPU_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://open.bigmodel.cn/api/paas/v4'),
    models: [
      {
        id: 'glm-4-plus',
        name: 'GLM-4 Plus',
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        capabilities: ['function-call', 'reasoning'],
      },
      {
        id: 'glm-4-flash',
        name: 'GLM-4 Flash',
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        capabilities: ['function-call'],
      },
    ],
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    description: 'Moonshot 开放平台（OpenAI 兼容）',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://api.moonshot.cn/v1'),
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot v1 8K',
        contextWindow: 8_192,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot v1 32K',
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot v1 128K',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
    ],
  },
  {
    id: 'qwen',
    name: '阿里云百炼 / Qwen',
    description: 'DashScope OpenAI 兼容端点',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    models: [
      {
        id: 'qwen-max',
        name: 'Qwen Max',
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
      {
        id: 'qwen-plus',
        name: 'Qwen Plus',
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter 聚合端点（OpenAI 兼容）',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: openaiCompatible('https://openrouter.ai/api/v1'),
    models: [
      {
        id: 'openrouter/auto',
        name: 'OpenRouter Auto',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: ['function-call'],
      },
    ],
  },
]
