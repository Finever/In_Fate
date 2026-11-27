import { readFileSync } from 'node:fs'

function readVersion(): string {
  try {
    return readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim()
  } catch {
    return '0.0.0-dev'
  }
}

export const IF_VERSION = readVersion()
export const IF_NAME = 'In_Fate'
