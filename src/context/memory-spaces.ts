import type { ContextSection, PipelineContext } from './types.ts'
import type { MemorySpaceAccess } from '../memory/space-access.ts'

const KIND_TEXT: Record<string, string> = {
  private: '私域',
  shared: '共有',
  user: '用户空间',
}

export function memorySpacesSection(
  id: string,
  access: MemorySpaceAccess,
  priority = 92,
): ContextSection {
  return {
    id,
    layer: 'dynamic',
    priority,
    render: (context: PipelineContext) => {
      const spaces = access.describe(context.sessionId)
      if (spaces.length === 0) return
      const lines = spaces.map(space => [
        `- ${space.id}（${KIND_TEXT[space.kind] ?? space.kind}，角色 ${space.role}`,
        space.autoPush ? '，自动推送' : '',
        space.description ? `）${space.description}` : '）',
      ].join(''))
      return {
        text: [
          '## 记忆空间',
          '',
          '除共享 detail 外，你还可以访问下面这些记忆空间；用 memory_search / memory_read / memory_add 等工具的 space 参数读写，不要凭记忆猜内容。',
          ...lines,
        ].join('\n'),
        meta: { spaces: spaces.length },
      }
    },
  }
}
