/**
 * AI 风险操作守卫：在工具审批之前，按工具名 + 参数做一次风险分级。
 *
 * 它不是沙箱，也不替代 FS/Network policy；只负责把“模型准备做的危险动作”
 * 标出来，交给审批/拒绝。默认只对 high 及以上发问，critical 直接拒绝。
 *
 * @module if/core/risk-guard
 */

import { isAbsolute, relative, resolve } from 'node:path'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type RiskMode = 'ask' | 'deny'

export interface RiskGuardOptions {
  readonly enabled?: boolean
  readonly mode?: RiskMode
  readonly askLevel?: RiskLevel
  readonly denyLevel?: RiskLevel
}

export interface RiskFinding {
  readonly level: RiskLevel
  readonly rule: string
  readonly reason: string
}

export interface RiskGuardDecision extends RiskFinding {
  readonly decision: 'ask' | 'deny'
}

const LEVEL_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

const LEVELS = new Set<RiskLevel>(['low', 'medium', 'high', 'critical'])

interface RiskRule {
  readonly level: RiskLevel
  readonly rule: string
  readonly reason: string
  readonly re: RegExp
}

const BASH_RULES: readonly RiskRule[] = [
  {
    level: 'critical',
    rule: 'system-destructive',
    reason: '系统级破坏命令（格式化/分区/关机/引导）',
    re: /(?:^|[;&|]\s*|\b(?:then|do)\s+)(?:sudo\s+)?(?:format(?:\.com)?\s+[a-z]:|diskpart|mkfs(?:\.\w+)?|bcdedit|shutdown|reboot|halt)(?:\s|$)/i,
  },
  {
    level: 'critical',
    rule: 'pipe-to-shell',
    reason: '下载内容直接管道给 shell',
    re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh)\b/i,
  },
  {
    level: 'high',
    rule: 'recursive-delete',
    reason: '递归/强制删除',
    re: /\brm\s+(?:-[a-z]*[rf][a-z]*|--(?:recursive|force))\b/i,
  },
  {
    level: 'high',
    rule: 'windows-delete',
    reason: '递归/强制删除',
    re: /\b(?:rd|rmdir)\s+\/s|\bdel\s+\/[a-z]*[fsq]/i,
  },
  {
    level: 'high',
    rule: 'git-rewrite',
    reason: '重写 git 历史或强推',
    re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*[fd]|push\s+[^\n]*--force(?:-with-lease)?)/i,
  },
  {
    level: 'high',
    rule: 'privilege',
    reason: '提权或修改 ACL',
    re: /\b(?:sudo|runas|takeown|icacls)\b/i,
  },
  {
    level: 'high',
    rule: 'service-registry',
    reason: '修改注册表/服务/账号',
    re: /\b(?:reg\s+(?:add|delete)|sc\s+(?:delete|stop|config)|net\s+user)\b/i,
  },
  {
    level: 'high',
    rule: 'kill-force',
    reason: '强制结束进程',
    re: /\b(?:taskkill\s+\/f|kill\s+-9)\b/i,
  },
  {
    level: 'high',
    rule: 'permissions',
    reason: '放开或清空文件权限',
    re: /\b(?:chmod|chown)\s+(?:-R\s+)?(?:777|000)\b/i,
  },
  {
    level: 'high',
    rule: 'publish',
    reason: '发布到外部仓库',
    re: /\b(?:npm|pnpm|yarn)\s+publish\b|\b(?:twine|cargo)\s+publish\b/i,
  },
  {
    level: 'high',
    rule: 'encoded-powershell',
    reason: '编码 PowerShell 命令',
    re: /\bpowershell(?:\.exe)?\s+[^\n]*\s-(?:enc|encodedcommand)\b/i,
  },
  {
    level: 'medium',
    rule: 'global-install',
    reason: '安装全局/系统级依赖',
    re: /\b(?:npm|pnpm|yarn)\s+(?:add|install)\s+-g\b|\bpip\s+install\b/i,
  },
]

const SENSITIVE_PATH_RULES: readonly RiskRule[] = [
  {
    level: 'high',
    rule: 'ssh',
    reason: 'SSH 私钥/配置目录',
    re: /(^|\/)\.ssh(\/|$)/i,
  },
  {
    level: 'high',
    rule: 'cloud-credentials',
    reason: '云凭据目录',
    re: /(^|\/)\.aws(\/|$)/i,
  },
  {
    level: 'high',
    rule: 'credentials',
    reason: '凭据/环境变量文件',
    re: /(^|\/)\.(?:npmrc|git-credentials|netrc)$/i,
  },
  {
    level: 'high',
    rule: 'dotenv',
    reason: '环境变量文件可能含密钥',
    re: /(^|\/)\.env(?:\.[^/]+)?$/i,
  },
  {
    level: 'high',
    rule: 'local-config',
    reason: '本地配置可能含 API key',
    re: /(^|\/)config\/if\.local\.json$/i,
  },
  {
    level: 'critical',
    rule: 'system-file',
    reason: '系统目录/文件',
    re: /^[a-z]:\/(?:windows|program files|program files \(x86\))(\/|$)/i,
  },
  {
    level: 'critical',
    rule: 'system-file',
    reason: '系统目录/文件',
    re: /^\/(?:etc|usr|bin|sbin|boot|dev|proc|sys)(\/|$)/i,
  },
]

function rank(level: RiskLevel): number {
  return LEVEL_RANK[level]
}

function highest(findings: readonly RiskFinding[]): RiskFinding | undefined {
  let best: RiskFinding | undefined
  for (const finding of findings) {
    if (!best || rank(finding.level) > rank(best.level)) best = finding
  }
  return best
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

function filePathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const path = (args as { file_path?: unknown }).file_path
  return typeof path === 'string' && path.trim() !== '' ? path : undefined
}

export class RiskGuard {
  readonly enabled: boolean
  readonly mode: RiskMode
  readonly askLevel: RiskLevel
  readonly denyLevel: RiskLevel

  constructor(options: RiskGuardOptions = {}) {
    this.enabled = options.enabled !== false
    this.mode = options.mode === 'deny' ? 'deny' : 'ask'
    this.askLevel = options.askLevel && LEVELS.has(options.askLevel) ? options.askLevel : 'high'
    this.denyLevel = options.denyLevel && LEVELS.has(options.denyLevel) ? options.denyLevel : 'critical'
  }

  inspect(toolName: string, args: unknown, cwd: string): RiskFinding | undefined {
    if (!this.enabled) return undefined
    if (toolName === 'bash') {
      const command = commandOf(args)
      if (!command) return undefined
      const findings = BASH_RULES
        .filter(rule => rule.re.test(command))
        .map(rule => ({ level: rule.level, rule: rule.rule, reason: rule.reason }))
      return highest(findings)
    }

    if (toolName === 'write' || toolName === 'edit' || toolName === 'read') {
      const raw = filePathOf(args)
      if (!raw) return undefined
      const absolute = resolve(cwd, raw)
      const normalized = absolute.replaceAll('\\', '/')
      const findings: RiskFinding[] = []
      for (const rule of SENSITIVE_PATH_RULES) {
        if (rule.re.test(normalized)) {
          findings.push({ level: rule.level, rule: rule.rule, reason: rule.reason })
        }
      }
      if (toolName !== 'read') {
        const rel = relative(cwd, absolute)
        if (rel.startsWith('..') || isAbsolute(rel)) {
          findings.push({
            level: 'medium',
            rule: 'outside-workspace',
            reason: '写入工作区之外',
          })
        }
      }
      return highest(findings)
    }

    return undefined
  }

  decide(finding: RiskFinding | undefined): RiskGuardDecision | undefined {
    if (!finding) return undefined
    if (rank(finding.level) >= rank(this.denyLevel)) {
      return { ...finding, decision: 'deny' }
    }
    if (rank(finding.level) >= rank(this.askLevel)) {
      return { ...finding, decision: this.mode === 'deny' ? 'deny' : 'ask' }
    }
    return undefined
  }

  check(toolName: string, args: unknown, cwd: string): RiskGuardDecision | undefined {
    return this.decide(this.inspect(toolName, args, cwd))
  }
}
