export interface SSEMessage {
  readonly event?: string
  readonly data: string
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      // CRLF 也按空行切；先把 \r 去掉，避免跨块时 \r\n 拆开漏切。
      buffer = buffer.replace(/\r/g, '')

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const message = parseBlock(block)
        if (message) yield message
        boundary = buffer.indexOf('\n\n')
      }
    }

    const tail = buffer.trim()
    if (tail.length > 0) {
      const message = parseBlock(tail)
      if (message) yield message
    }
  } finally {
    // 上层可能读到 [DONE] / message_stop 就提前返回，别把连接晾着。
    await reader.cancel().catch(() => {})
  }
}

function parseBlock(block: string): SSEMessage | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart())
    }
  }
  if (data.length === 0) return undefined
  return { data: data.join('\n'), ...(event ? { event } : {}) }
}
