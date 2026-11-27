/** 内置聚合种类；扩展种类直接传自定义字符串。 */
export type StreamKind = 'session' | 'task' | 'process' | 'agent' | (string & {})

export interface StreamAddress {
  readonly kind: string
  readonly id: string
}

export function streamId(kind: StreamKind, id: string): string {
  if (!id) throw new Error(`empty stream id: ${kind}`)
  return `${kind}:${id}`
}

export const sessionStream = (id: string): string => streamId('session', id)
export const taskStream = (id: string): string => streamId('task', id)
export const processStream = (id: string): string => streamId('process', id)
export const agentStream = (id: string): string => streamId('agent', id)

export function parseStream(stream: string): StreamAddress {
  const at = stream.indexOf(':')
  if (at <= 0 || at === stream.length - 1) throw new Error(`invalid stream: ${stream}`)
  return { kind: stream.slice(0, at), id: stream.slice(at + 1) }
}
