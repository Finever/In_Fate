/**
 * request_agent：受理一项子 agent 请求，立即返回 requestId。
 *
 * 它不是同步工具——结果通过 agent 流与一条系统消息回送。
 *
 * @module if/tools/builtin/request-agent
 */

import type { AgentManager } from '../../agents/manager.ts'
import type { PresetRegistry } from '../../agents/presets.ts'
import type { ToolDefinition, ToolResult } from '../types.ts'

export interface RequestAgentOptions {
  readonly manager: AgentManager
  readonly presets: PresetRegistry
  /** 不传则用工具调用上下文里的 sessionId */
  readonly sourceSession?: string
  readonly sourceTurn?: number
  /** 父级允许的预设集合；不传表示全部 */
  readonly allowedPresets?: readonly string[]
}

interface RequestInput {
  readonly preset: string
  readonly prompt: string
  readonly context?: string
  readonly acceptance?: readonly string[]
  readonly priority?: 'interactive' | 'normal' | 'background'
}

export function createRequestAgentTool(options: RequestAgentOptions): ToolDefinition {
  const available = options.presets
    .list()
    .filter(preset => !options.allowedPresets || options.allowedPresets.includes(preset.id))

  const description = [
    '把一项独立任务派给子 agent。受理即返回 requestId，不等待结果；完成后会收到一条系统消息。',
    '只在你明确要把工作交给子 agent 时使用。可用预设：',
    ...available.map(preset => `- ${preset.id}：${preset.description}（最多 ${preset.maxSteps} 步）`),
  ].join('\n')

  return {
    name: 'request_agent',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: available.map(preset => preset.id) },
        prompt: { type: 'string', description: '完整任务提示' },
        context: { type: 'string', description: '必要背景，不要粘贴整段对话' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收条目' },
        priority: {
          type: 'string',
          enum: ['interactive', 'normal', 'background'],
          description: '默认 normal',
        },
      },
      required: ['preset', 'prompt'],
      additionalProperties: false,
    },
    meta: { readOnly: true },

    async run(args, context): Promise<ToolResult> {
      const input = args as RequestInput
      const sourceSession = options.sourceSession ?? context.sessionId
      if (!sourceSession) return { text: 'no source session', isError: true }
      const preset = options.presets.get(input.preset)
      if (!preset) {
        return { text: `unknown preset: ${input.preset}`, isError: true }
      }
      if (options.allowedPresets && !options.allowedPresets.includes(preset.id)) {
        return { text: `preset not allowed: ${preset.id}`, isError: true }
      }

      try {
        const request = options.manager.submit({
          preset: preset.id,
          prompt: input.prompt,
          ...(input.context ? { context: input.context } : {}),
          ...(input.acceptance ? { acceptance: input.acceptance } : {}),
          priority: input.priority ?? 'normal',
          source: {
            session: sourceSession,
            ...(options.sourceTurn !== undefined ? { turn: options.sourceTurn } : {}),
          },
        }, preset)

        return {
          text: `accepted: ${request.id}`,
          structured: {
            requestId: request.id,
            preset: preset.id,
            queuePosition: options.manager.queueLength(),
            active: options.manager.activeCount(),
          },
          bytes: Buffer.byteLength(request.id, 'utf8'),
          encoding: 'utf-8',
        }
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }
    },
  }
}
