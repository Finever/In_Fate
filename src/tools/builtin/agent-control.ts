import type { AgentManager } from '../../agents/manager.ts'
import type { ToolDefinition, ToolResult } from '../types.ts'

export interface AgentControlOptions {
  readonly manager: AgentManager
}

export function createAgentControlTools(options: AgentControlOptions): ToolDefinition[] {
  return [
    {
      name: 'agent_status',
      description: '查子 agent 状态：queued、running 或终态结果。',
      inputSchema: {
        type: 'object',
        properties: { requestId: { type: 'string' } },
        required: ['requestId'],
        additionalProperties: false,
      },
      meta: { readOnly: true },

      async run(args): Promise<ToolResult> {
        const { requestId } = args as { requestId: string }
        const status = options.manager.status(requestId)
        if (status === undefined) return { text: 'not found', isError: true }

        if (typeof status === 'string') {
          return { text: status, structured: { status } }
        }

        return {
          text: `${status.status}: ${status.summary || status.error || ''}`.trim(),
          structured: status,
        }
      },
    },
    {
      name: 'agent_interrupt',
      description: '中断排队或运行中的子 agent。',
      inputSchema: {
        type: 'object',
        properties: { requestId: { type: 'string' } },
        required: ['requestId'],
        additionalProperties: false,
      },
      meta: { readOnly: true },

      async run(args): Promise<ToolResult> {
        const { requestId } = args as { requestId: string }
        const ok = options.manager.interrupt(requestId)
        return { text: ok ? 'interrupted' : 'not found', isError: !ok }
      },
    },
    {
      name: 'agent_list',
      description: '列出最近派出的子 agent。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      meta: { readOnly: true },

      async run(args): Promise<ToolResult> {
        const { limit = 20 } = args as { limit?: number }
        const items = options.manager.list(limit)
        const text = items
          .map(item => {
            if ('status' in item && typeof item.status === 'string' && (item.status === 'queued' || item.status === 'running')) {
              return `${item.id} [${item.status}] ${item.preset}`
            }
            const result = item as {
              id: string
              status: string
              preset: string
              summary: string
            }
            return `${result.id} [${result.status}] ${result.preset} ${result.summary}`
          })
          .join('\n')
        return { text: text || '（没有子 agent）', structured: { count: items.length } }
      },
    },
  ]
}
