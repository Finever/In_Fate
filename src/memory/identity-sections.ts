export function assertIdentitySection(section: string): void {
  if (section.trim().length === 0 || section.includes('\n') || section.length > 80) {
    throw new Error(`invalid identity section: ${JSON.stringify(section)}`)
  }
}

export function replaceIdentitySection(text: string, section: string, content: string): string {
  assertIdentitySection(section)
  const lines = text.split('\n')
  const heading = `## ${section}`
  const start = lines.findIndex(line => line.trim() === heading)
  if (start < 0) throw new Error(`identity section not found: ${section}`)

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index]!)) {
      end = index
      break
    }
  }

  const body = content.split('\n')
  const before = lines.slice(0, start + 1)
  const after = lines.slice(end)
  return [...before, '', ...body, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n')
}

export function appendIdentitySection(text: string, section: string, content: string): string {
  assertIdentitySection(section)
  if (text.split('\n').some(line => line.trim() === `## ${section}`)) {
    throw new Error(`identity section already exists: ${section}`)
  }
  return `${text.trimEnd()}\n\n## ${section}\n\n${content.trim()}\n`
}
