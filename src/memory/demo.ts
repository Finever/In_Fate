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
import { generateIndex } from './index.ts'
import { findQuotes, formatAddress, parseAddress } from './quote.ts'
import { appendLog, buildTurn, clock, readLog } from './log.ts'
import { defaultSources, readSources } from './sources.ts'

const target = process.argv[2] ?? join(process.cwd(), 'memory', 'detail', 'example', 'example.json')
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

// --- index：扫真库，只生成不写盘 ---
const memoryRoot = join(process.cwd(), 'memory')
const index = generateIndex({ memoryRoot })
console.log('索引条目：', index.items.length)

// --- quote：地址往返 + 真流水检索（只读） ---
const address = formatAddress('2026-10-18', 'demo-session', 34)
console.log('地址：', address, '→', JSON.stringify(parseAddress(address)))
const hits = findQuotes({ memoryRoot, phrase: '通用框架', userName: 'Demo User', limit: 3 })
console.log('检索命中：', hits.length, hits[0]?.address ?? '')

// --- log：在临时目录写一轮 ---
const logFile = join(dir, 'demo-log.jsonl')
appendLog(logFile, buildTurn(1, 'Demo Agent', [{ type: 'text', p: '测试' }], clock(new Date())))
console.log('流水行数：', readLog(logFile).length)

// --- sources：只读当前 agent 的三份文件 ---
const agentDir = join(process.cwd(), 'agent')
const sources = readSources(defaultSources(agentDir))
console.log('源：', sources.map(source => `${source.id}=${source.bytes}B`).join(', '))
