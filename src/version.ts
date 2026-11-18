/**
 * 版本号唯一来源：仓库根目录的 VERSION。
 *
 * 发布脚本、CLI、HTTP 都读这里；不要在代码里再写死版本号。
 * @module if/version
 */

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
