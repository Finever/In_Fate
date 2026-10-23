/**
 * 系统消息标识：让模型一眼看出这段不是用户说的、也不是助手说的。
 *
 * 标识放在内容开头，不依赖 role——适配层可能把 system 映射成 user，
 * 但文字里的标识不会丢。
 *
 * @module if/context/marks
 */

export type SystemMarkKind = 'compaction' | 'scheduled' | 'injection' | 'time' | 'session'

const LABELS: Record<SystemMarkKind, string> = {
  compaction: '压缩摘要',
  scheduled: '定时任务',
  injection: '上下文注入',
  time: '当前时间',
  session: '跨会话消息',
}

export function markSystem(
  kind: SystemMarkKind,
  text: string,
  meta?: Readonly<Record<string, string>>,
): string {
  const extra = meta && Object.keys(meta).length > 0
    ? ' ' + Object.entries(meta).map(([key, value]) => `${key}=${value}`).join(' ')
    : ''
  return `[系统：${LABELS[kind]}${extra}]\n${text}`
}
