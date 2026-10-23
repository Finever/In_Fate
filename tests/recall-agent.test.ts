import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventStore } from '../src/core/store.ts'
import { createRecallTool } from '../src/tools/builtin/recall.ts'

test('recall 能读子 agent 自己的流', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'if-recall-agent-'))
  try {
    const main = new EventStore(join(dir, 'session.jsonl'))
    const child = new EventStore(join(dir, 'agent-x.jsonl'))
    child.append({
      stream: 'agent:agent-x',
      actor: 'agent',
      type: 'agent.completed',
      payload: { requestId: 'agent-x', preset: 'researcher', summary: '完成', artifacts: [], usage: { input: 1, output: 1, cacheRead: 0 }, steps: 1 },
    })

    const tool = createRecallTool(main, { agentStore: () => child })
    const result = await tool.run({ agentRequestId: 'agent-x' }, {
      sessionId: 's',
      callId: 'call',
      cwd: process.cwd(),
      signal: new AbortController().signal,
    })
    assert.match(result.text ?? '', /agent\.completed/)
    assert.equal((result.structured as { source: string }).source, 'agent')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
