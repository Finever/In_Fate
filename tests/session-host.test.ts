import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionHost } from '../src/session/host.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('同一会话任务串行，不同会话可并行状态独立', async () => {
  const host = new SessionHost()
  const order: string[] = []
  let active = 0
  let maxActive = 0

  const job = (id: string, wait: number) => host.run('s1', async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    order.push(`start-${id}`)
    await sleep(wait)
    order.push(`end-${id}`)
    active -= 1
    return id
  })

  const results = await Promise.all([job('a', 25), job('b', 1), job('c', 1)])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
  assert.equal(maxActive, 1)
  assert.equal(host.isActive('s1'), false)

  await host.run('s2', async () => {
    assert.equal(host.isActive('s1'), false)
    assert.equal(host.isActive('s2'), true)
  })
})

test('dispose 拒绝排队中的任务', async () => {
  const host = new SessionHost()
  const first = host.run('s', async () => {
    await sleep(30)
    return 'first'
  })
  const second = host.run('s', async () => 'second')

  host.dispose()
  await assert.rejects(second, /disposed/)
  assert.equal(await first, 'first')
})
