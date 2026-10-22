import assert from 'node:assert/strict'
import test from 'node:test'
import { TokenEstimator } from '../src/compaction/estimate.ts'
import { DEFAULT_COMPACTION } from '../src/compaction/types.ts'

test('estimator 用真实 usage 校准字符系数', () => {
  const estimator = new TokenEstimator(0.45)
  estimator.observe(1000, 500)
  assert.equal(estimator.factor, 0.5)
  assert.equal(estimator.estimate('x'.repeat(1000)), 500)

  estimator.observe(1000, 1000)
  assert.equal(estimator.factor, 0.75)
  assert.equal(estimator.estimate('x'.repeat(1000)), 750)
})

test('压缩默认给声明窗口留安全系数', () => {
  assert.equal(DEFAULT_COMPACTION.contextSafetyMargin, 0.9)
})
