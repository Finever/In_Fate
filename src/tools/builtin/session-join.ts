import type { SessionJoinScheduler } from '../../session/joins.ts'
import type { ToolDefinition } from '../types.ts'

export function createSessionJoinTool(deps: {
  readonly joins: SessionJoinScheduler
}): ToolDefinition {
  return {
    name: 'session_join',
    description:
      '等待一组已连接会话完成后再继续。调用后本轮进入 waiting，不占用模型；'
      + '目标完成或超时会自动唤醒。',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: '要等待的会话 id',
        },
        mode: { type: 'string', enum: ['all', 'any'], description: '默认 all' },
        timeoutMs: { type: 'number', minimum: 1, description: '默认 120000' },
      },
      required: ['targets'],
      additionalProperties: false,
    },
    async run(args, context) {
      const input = args as {
        targets: string[]
        mode?: 'all' | 'any'
        timeoutMs?: number
      }
      const join = deps.joins.create({
        sessionId: context.sessionId,
        targets: input.targets,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      const targetText = join.targets.join('、')
      return {
        text: `等待 ${targetText}（${join.mode}${join.status === 'done' ? '，已满足' : ''}）`,
        ...(join.status === 'pending' ? { waiting: true } : {}),
        structured: {
          joinId: join.joinId,
          targets: join.targets,
          mode: join.mode,
          status: join.status,
        },
      }
    },
  }
}
