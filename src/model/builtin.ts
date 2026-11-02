/**
 * 内置模型服务商模板：只给端点，不猜模型。
 *
 * 这些只是「添加服务商」时的参考，不会自动注册；模型列表由用户用
 * 「读取模型列表」或手动添加。同一个模板可以带多种端点格式，
 * 例如 DeepSeek 同时提供 OpenAI Chat、Responses 与 Anthropic Messages。
 *
 * @module if/model/builtin
 */

import type { EndpointConfig, ProviderConfig } from './types.ts'

const endpoint = (adapterFamily: string, baseUrl: string): EndpointConfig => ({
  adapterFamily,
  baseUrl,
})

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI 官方 API（Responses / Chat Completions）',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultChatEndpoint: 'openai-responses',
    endpoints: {
      'openai-responses': endpoint('openai-responses', 'https://api.openai.com'),
      'openai-chat-completions': endpoint('openai-chat-completions', 'https://api.openai.com/v1'),
    },
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude 官方 API（Anthropic Messages）',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultChatEndpoint: 'anthropic-messages',
    endpoints: {
      'anthropic-messages': endpoint('anthropic-messages', 'https://api.anthropic.com'),
    },
    models: [],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google AI Studio / Gemini API（Generate Content）',
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultChatEndpoint: 'google-generate-content',
    endpoints: {
      'google-generate-content': endpoint(
        'google-generate-content',
        'https://generativelanguage.googleapis.com',
      ),
    },
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 官方 API（Chat / Responses / Anthropic Messages）',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': endpoint('openai-chat-completions', 'https://api.deepseek.com/v1'),
      'openai-responses': endpoint('openai-responses', 'https://api.deepseek.com'),
      'anthropic-messages': endpoint('anthropic-messages', 'https://api.deepseek.com/anthropic'),
    },
    models: [],
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    description: 'Moonshot 开放平台（Chat / Anthropic Messages）',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': endpoint('openai-chat-completions', 'https://api.moonshot.cn/v1'),
      'anthropic-messages': endpoint('anthropic-messages', 'https://api.moonshot.cn/anthropic'),
    },
    models: [],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    description: '智谱开放平台（Chat / Anthropic Messages）',
    apiKeyEnv: 'ZHIPU_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': endpoint(
        'openai-chat-completions',
        'https://open.bigmodel.cn/api/paas/v4',
      ),
      'anthropic-messages': endpoint('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic'),
    },
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter 聚合端点（Chat / Anthropic Messages）',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': endpoint('openai-chat-completions', 'https://openrouter.ai/api/v1'),
      'anthropic-messages': endpoint('anthropic-messages', 'https://openrouter.ai/api'),
    },
    models: [],
  },
  {
    id: 'qwen',
    name: '阿里云百炼 / Qwen',
    description: 'DashScope OpenAI 兼容端点',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultChatEndpoint: 'openai-chat-completions',
    endpoints: {
      'openai-chat-completions': endpoint(
        'openai-chat-completions',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ),
    },
    models: [],
  },
]
