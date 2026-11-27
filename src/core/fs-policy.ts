import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { assertWithin, IfPathError } from './safe-path.ts'

export interface FsPolicyOptions {
  readonly readRoots: readonly string[]
  /** 不传就与 readRoots 相同 */
  readonly writeRoots?: readonly string[]
}

function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** 找到最近一个存在的祖先，解析它，再拼回不存在的尾部。 */
function realTarget(path: string): string {
  let probe = path
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return resolve(probe)
    probe = parent
  }
  const suffix = relative(probe, path)
  return resolve(realOrResolved(probe), suffix)
}

export class FsPolicy {
  readonly readRoots: readonly string[]
  readonly writeRoots: readonly string[]

  constructor(options: FsPolicyOptions) {
    if (options.readRoots.length === 0) {
      throw new IfPathError('fs policy needs at least one read root', '')
    }
    this.readRoots = options.readRoots.map(root => resolve(root))
    this.writeRoots = (options.writeRoots ?? options.readRoots).map(root => resolve(root))
  }

  resolveRead(target: string, cwd?: string): string {
    return this.resolve(this.readRoots, target, cwd, 'read')
  }

  resolveWrite(target: string, cwd?: string): string {
    return this.resolve(this.writeRoots, target, cwd, 'write')
  }

  private resolve(
    roots: readonly string[],
    target: string,
    cwd: string | undefined,
    label: string,
  ): string {
    const absolute = resolve(cwd ?? process.cwd(), target)
    let root: string | undefined
    for (const candidate of roots) {
      try {
        assertWithin(candidate, absolute, label)
        root = candidate
        break
      } catch {
        // 换下一个根
      }
    }

    if (!root) {
      throw new IfPathError(
        `fs sandbox: ${label} path outside allowed roots: ${absolute}`,
        target,
      )
    }

    // 词法通过后再验真实路径：父目录或文件本身可能是链接。
    const realRoot = realOrResolved(root)
    const real = realTarget(absolute)
    try {
      assertWithin(realRoot, real, label)
    } catch {
      throw new IfPathError(
        `fs sandbox: ${label} path escapes through symlink: ${absolute}`,
        target,
      )
    }
    return absolute
  }
}
