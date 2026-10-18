/**
 * memory 三件套的最小验证：
 *   1. 拿真库的一份文件只读校验；
 *   2. 在临时副本上追加一条，验接号、键序、落盘。
 * 真库一个字节都不动。
 *
 * @module if/memory/demo
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryFile } from './entry.ts'
import { summarize, validateFile } from './validate.ts'
import { appendToFile, writeMemoryFile } from './write.ts'

const target = process.argv[2] ?? 'C:/Users/qielan/work/memory/detail/him/这个人.json'
const doc = JSON.parse(readFileSync(target, 'utf8')) as MemoryFile

const result = validateFile(doc)
console.log(`校验 ${target}`)
console.log(' ', summarize(result))
for (const issue of [...result.errors, ...result.warnings].slice(0, 10)) {
  console.log(`  ${issue.level} ${issue.path}：${issue.message}`)
}

const dir = mkdtempSync(join(tmpdir(), 'if-memory-'))
const copy = join(dir, 'test.json')
writeMemoryFile(copy, doc)

const appended = appendToFile(copy, [
  {
    id: 'auto',
    'rec-time': '2026-10-18 19:35',
    tag: '有疑',
    content: '这是一条写入测试，不进真库。',
    quotes: [],
  },
])

console.log('追加到临时副本：', copy)
console.log('  新 id：', appended.added[0].id)
console.log('  条目数：', appended.file.entries.length)
