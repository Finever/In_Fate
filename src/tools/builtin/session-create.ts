import type { ToolDefinition } from '../types.ts'

export interface SpawnedSession {
  readonly sessionId: string
  readonly linkId: string
  readonly messageId: string
}

export function createSessionCreateTool(deps: {
  readonly spawn: (input: {
    creator: string
    text: string
    reason?: string
  }) => SpawnedSession
}): ToolDefinition {
  return {
    name: 'session_create',
    description:
      '创建一个新的用户所有会话，自动与当前会话建立 peer 连接并投递第一条任务。'
      + '新会话会并行运行；需要汇总时用 session_join 等待。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '给新会话的第一条任务' },
        reason: { type: 'string', description: '为什么创建，给用户看' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, context) {
      const input = args as { text: string; reason?: string }
      const spawned = deps.spawn({
        creator: context.sessionId,
        text: input.text,
        ...(input.reason ? { reason: input.reason } : {}),
      })
      return {
        text: `已创建会话 ${spawned.sessionId}，连接 ${spawned.linkId}`,
        structured: spawned,
      }
    },
  }
}
