#!/usr/bin/env node
/**
 * 把旧 SOUL/USER/FACT 迁移到 agents/<id>/agent.json + identity 槽位。
 *
 * 默认 dry-run；加 --apply 才写文件。旧文件永远不动。
 *
 * 用法：
 *   node bin/migrate-identity.ts \
 *     --memory-root C:\Users\qielan\work\memory \
 *     --agent-dir C:\Users\qielan\AppData\Roaming\CherryStudio\Data\Agents\<id> \
 *     --agent-id main \
 *     --name 未凉 \
 *     --labels 本心,所爱,当口 \
 *     --apply
 */

import { parseArgs } from 'node:util'
import {
  applyIdentityMigration,
  planIdentityMigration,
} from '../src/memory/migrate-identity.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'memory-root': { type: 'string' },
      'agent-dir': { type: 'string' },
      'agent-id': { type: 'string', default: 'main' },
      name: { type: 'string' },
      labels: { type: 'string' },
      apply: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    process.stdout.write(`用法：
  node bin/migrate-identity.ts --memory-root <记忆库根> --agent-dir <agent 目录> [--agent-id main] [--name 未凉] [--labels 本心,所爱,当口] [--apply] [--force]

默认 dry-run；--apply 才写 agents/<id>/agent.json 和 identity/*.md。旧 SOUL/USER/FACT 不动。
目标文件已存在且内容不同时默认拒绝；--force 先备份再覆盖。
`)
    return
  }

  const memoryRoot = values['memory-root']
  const agentDir = values['agent-dir']
  if (!memoryRoot || !agentDir) {
    throw new Error('--memory-root 和 --agent-dir 必填')
  }

  const labelParts = values.labels?.split(',').map(item => item.trim())
  if (labelParts && labelParts.length !== 3) {
    throw new Error('--labels 需要三个，用逗号分隔')
  }
  const labels = labelParts
    ? { self: labelParts[0]!, user: labelParts[1]!, context: labelParts[2]! }
    : undefined

  const plan = planIdentityMigration({
    memoryRoot,
    agentDir,
    agentId: values['agent-id'] ?? 'main',
    ...(values.name ? { name: values.name } : {}),
    ...(labels ? { labels } : {}),
  })

  process.stdout.write(`agent: ${plan.agentId}\n`)
  process.stdout.write(`manifest: ${plan.manifestPath}\n`)
  for (const file of plan.files) {
    const flags = [
      file.conflict ? 'CONFLICT' : '',
      file.identical ? 'same' : '',
    ].filter(Boolean).join(' ')
    process.stdout.write(`  ${file.slot}: ${file.source} -> ${file.target} (${file.bytes} B)${flags ? ` [${flags}]` : ''}\n`)
  }
  for (const missing of plan.missingLegacy) {
    process.stdout.write(`  missing legacy: ${missing}\n`)
  }

  if (!values.apply) {
    process.stdout.write('\ndry-run；确认后加 --apply。\n')
    return
  }

  const result = await applyIdentityMigration(plan, { force: values.force === true })
  process.stdout.write(`\nmanifest: ${result.manifestPath}\n`)
  process.stdout.write(`written: ${result.written.length}\n`)
  for (const path of result.written) process.stdout.write(`  ${path}\n`)
  if (result.skipped.length > 0) process.stdout.write(`skipped: ${result.skipped.length}\n`)
  if (result.backups.length > 0) {
    process.stdout.write('backups:\n')
    for (const path of result.backups) process.stdout.write(`  ${path}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
