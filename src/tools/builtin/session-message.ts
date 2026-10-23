/**
 * session_message：给已连接会话投递一条消息。
 *
 * 目标空闲时按 wake 开花；目标正在跑时消息进收件箱，下一步模型请求可见。
 *
 * @module if/tools/builtin/session-message
 */

import type {
  SendSessionMessageInput,
  SessionMessageDelivery,
} from '../../session/message.ts'
import type { ToolDefinition } from '../types.ts'

export function createSessionMessageTool(deps: {
  readonly send: (input: SendSessionMessageInput) => SessionMessageDelivery
}): ToolDefinition {
  return {
    name: 'session_message',
    description:
      '给已连接会话发消息。question/result 默认唤醒目标；note 只进收件箱。'
      + '目标正在跑时不会另开一轮，下一步模型请求会看到。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        text: { type: 'string' },
        kind: { type: 'string', enum: ['note', 'question', 'result', 'wake'] },
        replyTo: { type: 'string', description: '被回复的事件 id' },
        wake: { type: 'boolean' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    async run(args, context) {
      const input = args as {
        to: string
        text: string
        kind?: 'note' | 'question' | 'result' | 'wake'
        replyTo?: string
        wake?: boolean
      }
      const delivery = deps.send({
        from: context.sessionId,
        to: input.to,
        text: input.text,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.wake !== undefined ? { wake: input.wake } : {}),
      })
      return {
        text: `已投递 ${delivery.messageId}${delivery.woke ? '（已唤醒）' : ''}`,
        structured: delivery,
      }
    },
  }
}
