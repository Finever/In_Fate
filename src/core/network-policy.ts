import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export interface NetworkPolicyOptions {
  /** 允许私网/本机；本地开发或内网服务才打开 */
  readonly allowPrivateNetwork?: boolean
  /** 精确主机名或 `*.example.com` 通配，命中即跳过私网检查 */
  readonly allowHosts?: readonly string[]
  /** 永远拒绝，优先级高于 allowHosts */
  readonly denyHosts?: readonly string[]
  /** 最多跟随几次重定向 */
  readonly maxRedirects?: number
  /** 测试注入 */
  readonly lookup?: NetworkLookup
}

export type NetworkLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>

export class NetworkPolicyError extends Error {
  readonly url: string

  constructor(message: string, url: string) {
    super(message)
    this.name = 'NetworkPolicyError'
    this.url = url
  }
}

const BLOCKED = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6')
}
BLOCKED.addAddress('::', 'ipv6')
BLOCKED.addAddress('::1', 'ipv6')

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return BLOCKED.check(address, 'ipv4')
  if (family === 6) {
    // IPv4-mapped IPv6：拆出来按 IPv4 规则查，避免 ::ffff:127.0.0.1 绕过。
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (mapped) return isBlockedAddress(mapped[1]!)
    return BLOCKED.check(address, 'ipv6')
  }
  return false
}

function hostMatches(patterns: readonly string[], hostname: string): boolean {
  return patterns.some(raw => {
    const pattern = raw.toLowerCase()
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      return hostname.endsWith(suffix) && hostname.length > suffix.length
    }
    return hostname === pattern
  })
}

const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal'])

export class NetworkPolicy {
  private readonly allowPrivateNetwork: boolean
  private readonly allowHosts: readonly string[]
  private readonly denyHosts: readonly string[]
  readonly maxRedirects: number
  private readonly lookup: NetworkLookup

  constructor(options: NetworkPolicyOptions = {}) {
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false
    this.allowHosts = options.allowHosts ?? []
    this.denyHosts = options.denyHosts ?? []
    this.maxRedirects = Math.max(0, options.maxRedirects ?? 5)
    this.lookup = options.lookup ?? (async (hostname, lookupOptions) => lookup(hostname, lookupOptions))
  }

  /**
   * 校验并返回规范化 URL。
   * `resolve: false` 用于服务端抓取（deepseek），只做字面量与协议检查。
   */
  async check(url: string, options: { resolve?: boolean } = {}): Promise<URL> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new NetworkPolicyError(`invalid url: ${url}`, url)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NetworkPolicyError(`network policy: unsupported protocol ${parsed.protocol}`, url)
    }

    const hostname = stripBrackets(parsed.hostname).toLowerCase().replace(/\.$/, '')
    if (hostMatches(this.denyHosts, hostname)) {
      throw new NetworkPolicyError(`network policy: host denied: ${hostname}`, url)
    }
    if (hostMatches(this.allowHosts, hostname)) return parsed
    if (this.allowPrivateNetwork) return parsed

    if (LOCAL_NAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new NetworkPolicyError(`network policy: local host blocked: ${hostname}`, url)
    }

    if (isIP(hostname)) {
      if (isBlockedAddress(hostname)) {
        throw new NetworkPolicyError(`network policy: private address blocked: ${hostname}`, url)
      }
      return parsed
    }

    if (options.resolve === false) return parsed

    let addresses: readonly { address: string; family: number }[]
    try {
      addresses = await this.lookup(hostname, { all: true, verbatim: true })
    } catch (error) {
      throw new NetworkPolicyError(
        `network policy: dns lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
        url,
      )
    }

    if (addresses.length === 0) {
      throw new NetworkPolicyError(`network policy: no address for ${hostname}`, url)
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new NetworkPolicyError(
          `network policy: ${hostname} resolves to private address ${address}`,
          url,
        )
      }
    }
    return parsed
  }
}
