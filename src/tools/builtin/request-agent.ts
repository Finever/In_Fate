import type { AgentManager } from '../../agents/manager.ts'
import type { PresetRegistry } from '../../agents/presets.ts'
import type { ModelRef, SubagentPolicy } from '../../agents/settings.ts'
import type { AgentPreset } from '../../agents/types.ts'
import type { ToolDefinition, ToolResult } from '../types.ts'

export interface RequestAgentOptions {
  readonly manager: AgentManager
  readonly presets: PresetRegistry
  /** 不传则用工具调用上下文里的 sessionId */
  readonly sourceSession?: string
  readonly sourceTurn?: number
  /** 父级允许的预设集合；不传表示全部 */
  readonly allowedPresets?: readonly string[]
  /** 按来源会话解析主 agent 的子 agent 策略。 */
  readonly resolvePolicy?: (sessionId: string) => SubagentPolicy | undefined
}

interface RequestInput {
  readonly preset: string
  readonly prompt: string
  readonly context?: string
  readonly acceptance?: readonly string[]
  readonly priority?: 'interactive' | 'normal' | 'background'
  readonly model?: ModelRef
}

function modelKey(choice: ModelRef): string {
  return `${choice.provider}\u0000${choice.model}`
}

function allowedPresetsFor(
  policy: SubagentPolicy | undefined,
  options: RequestAgentOptions,
): AgentPreset[] {
  return options.presets.list().filter(preset => {
    if (options.allowedPresets && !options.allowedPresets.includes(preset.id)) return false
    if (policy?.presets && !policy.presets.includes(preset.id)) return false
    return true
  })
}

function effectivePreset(
  preset: AgentPreset,
  policy: SubagentPolicy | undefined,
  chosen: ModelRef | undefined,
): AgentPreset | undefined {
  const allowed = new Map((policy?.models ?? []).map(choice => [modelKey(choice), choice]))
  let models: ModelRef[]
  if (chosen) {
    if (allowed.size > 0 && !allowed.has(modelKey(chosen))) return undefined
    models = [chosen]
  } else if (allowed.size === 0) {
    models = [...preset.models]
  } else {
    models = preset.models.filter(choice => allowed.has(modelKey(choice)))
    if (models.length === 0 && policy?.mainModel) models = [policy.mainModel]
  }
  if (models.length === 0) return undefined

  const toolAllow = policy?.toolAllow !== undefined
    ? new Set(policy.toolAllow)
    : undefined
  return {
    ...preset,
    models,
    tools: preset.tools.filter(name => !toolAllow || toolAllow.has(name)),
  }
}

export function createRequestAgentTool(options: RequestAgentOptions): ToolDefinition {
  const available = options.presets
    .list()
    .filter(preset => !options.allowedPresets || options.allowedPresets.includes(preset.id))

  const description = [
    '把一项独立任务派给子 agent。受理即返回 requestId，不等待结果；完成后会收到一条系统消息。',
    '只在你明确要把工作交给子 agent 时使用。可用预设：',
    ...available.map(preset => `- ${preset.id}：${preset.description}（最多 ${preset.maxSteps} 步）`),
    '可用模型请先调用 model_list 查看；不传 model 时按预设模型链和当前 agent 的可用列表选择。',
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
        model: {
          type: 'object',
          description: '可选；从 model_list 的可用模型里指定 provider/model',
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
          },
          required: ['provider', 'model'],
          additionalProperties: false,
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
      const policy = options.resolvePolicy?.(sourceSession)
      if (policy?.presets && !policy.presets.includes(preset.id)) {
        return { text: `preset not allowed for this agent: ${preset.id}`, isError: true }
      }
      const effective = effectivePreset(preset, policy, input.model)
      if (!effective) {
        return {
          text: input.model
            ? `model not allowed for this agent: ${input.model.provider}/${input.model.model}`
            : `no model available for preset: ${preset.id}`,
          isError: true,
        }
      }

      try {
        const request = options.manager.submit({
          preset: effective.id,
          prompt: input.prompt,
          ...(input.context ? { context: input.context } : {}),
          ...(input.acceptance ? { acceptance: input.acceptance } : {}),
          priority: input.priority ?? 'normal',
          source: {
            session: sourceSession,
            ...(options.sourceTurn !== undefined ? { turn: options.sourceTurn } : {}),
          },
        }, effective)

        return {
          text: `accepted: ${request.id}`,
          structured: {
            requestId: request.id,
            preset: effective.id,
            models: effective.models,
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

export function modelListTool(options: {
  presets: PresetRegistry
  resolvePolicy: (sessionId: string) => SubagentPolicy | undefined
}): ToolDefinition {
  return {
    name: 'model_list',
    description: '列出当前主 agent 允许子 agent 使用的模型和预设。派活前先查这里。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    meta: { readOnly: true },

    async run(_args, context): Promise<ToolResult> {
      const policy = options.resolvePolicy(context.sessionId)
      const models = policy?.models ?? []
      const presets = policy?.presets ?? options.presets.list().map(preset => preset.id)
      const text = [
        `主模型：${policy?.mainModel ? `${policy.mainModel.provider}/${policy.mainModel.model}` : '未配置'}`,
        `可用子 agent 模型：${models.length > 0 ? models.map(item => `${item.provider}/${item.model}`).join('、') : '（无）'}`,
        `可用预设：${presets.length > 0 ? presets.join('、') : '（无）'}`,
      ].join('\n')
      return {
        text,
        structured: {
          mainModel: policy?.mainModel ?? null,
          models,
          presets,
        },
      }
    },
  } as ToolDefinition
}
