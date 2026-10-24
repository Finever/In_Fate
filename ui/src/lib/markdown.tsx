import { Fragment, type ReactNode } from 'react'

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g

function safeHref(value: string): string | undefined {
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : undefined
}

export function inlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={`c${match.index}`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`b${match.index}`}>{token.slice(2, -2)}</strong>)
    } else {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = safeHref(token.slice(split + 2, -1))
      nodes.push(href
        ? <a key={`a${match.index}`} href={href} target="_blank" rel="noreferrer">{label}</a>
        : label)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const trimmed = lines[index]!.trim()
    if (trimmed.length === 0) {
      index += 1
      continue
    }

    const fence = /^```(\S*)\s*$/.exec(trimmed)
    if (fence) {
      index += 1
      const body: string[] = []
      while (index < lines.length && !/^```\s*$/.test(lines[index]!.trim())) {
        body.push(lines[index]!)
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      index += 1
      continue
    }

    if (trimmed.startsWith('> ')) {
      const body: string[] = []
      while (index < lines.length && lines[index]!.trim().startsWith('> ')) {
        body.push(lines[index]!.trim().slice(2))
        index += 1
      }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }

    const ordered = /^(\d+)[.)]\s+/.exec(trimmed)
    const unordered = /^[-*+]\s+/.exec(trimmed)
    if (ordered || unordered) {
      const isOrdered = Boolean(ordered)
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index]!.trim()
        const hit = isOrdered ? /^(\d+)[.)]\s+(.*)$/.exec(current) : /^[-*+]\s+(.*)$/.exec(current)
        if (!hit) break
        items.push(isOrdered ? hit[2]! : hit[1]!)
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    const body: string[] = []
    while (index < lines.length) {
      const current = lines[index]!
      const currentTrimmed = current.trim()
      if (
        currentTrimmed.length === 0
        || /^```/.test(currentTrimmed)
        || /^(#{1,4})\s+/.test(currentTrimmed)
        || currentTrimmed.startsWith('> ')
        || /^(\d+)[.)]\s+/.test(currentTrimmed)
        || /^[-*+]\s+/.test(currentTrimmed)
      ) break
      body.push(current)
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') })
  }
  return blocks
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(4, block.level + 1)}`) as 'h2' | 'h3' | 'h4'
      return <Tag>{inlineNodes(block.text)}</Tag>
    }
    case 'code':
      return (
        <pre className="md-code" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return <blockquote>{inlineNodes(block.text)}</blockquote>
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{inlineNodes(item)}</li>)
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
    }
    default:
      return <p>{inlineNodes(block.text)}</p>
  }
}

export function Markdown({ text }: { text: string }): ReactNode {
  return (
    <div className="md">
      {parseBlocks(text).map((block, index) => (
        <Fragment key={index}>
          <BlockView block={block} />
        </Fragment>
      ))}
    </div>
  )
}
