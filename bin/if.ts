#!/usr/bin/env node
/**
 * IF 命令行入口。
 *
 * @module if/bin
 */

import { runCli } from '../src/app/cli.ts'

runCli(process.argv.slice(2)).catch(error => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
