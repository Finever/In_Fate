import assert from 'node:assert/strict'
import test from 'node:test'
import { Metrics } from '../src/core/metrics.ts'

test('计数、直方图、仪表按标签归并', () => {
  const metrics = new Metrics()
  metrics.inc('tool.calls')
  metrics.inc('tool.calls', 2, { tool: 'read' })
  metrics.inc('tool.calls', 1, { tool: 'read' })
  metrics.observe('tool.duration_ms', 10, { tool: 'read' })
  metrics.observe('tool.duration_ms', 20, { tool: 'read' })
  metrics.set('queue.depth', 3)

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.counters.find(item => item.name === 'tool.calls' && !item.labels)?.value, 1)
  assert.equal(snapshot.counters.find(item => item.labels?.tool === 'read')?.value, 3)

  const histogram = snapshot.histograms.find(item => item.labels?.tool === 'read')
  assert.equal(histogram?.count, 2)
  assert.equal(histogram?.sum, 30)
  assert.equal(histogram?.min, 10)
  assert.equal(histogram?.max, 20)

  assert.equal(snapshot.gauges.find(item => item.name === 'queue.depth')?.value, 3)
})
