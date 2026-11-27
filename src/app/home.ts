import { resolve } from 'node:path'

export function resolveIfHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.IF_HOME?.trim()
  if (explicit) return resolve(explicit)
  if (env.IF_PORTABLE === '1') return resolve(process.cwd(), 'data')
  return undefined
}
