import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelGate } from '../src/model/gate.ts'
import { ModelHttpError } from '../src/model/retry.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('provider 并发上限：第二个请求排队', async () => {
  const gate = new ModelGate({ maxConcurrentPerProvider: 1, waitMs: 500 })
  const first = await gate.acquire({ providerId: 'p' })
  let secondReady = false
  const second = gate.acquire({ providerId: 'p' }).then(release => {
    secondReady = true
    return release
  })

  await sleep(30)
  assert.equal(secondReady, false)
  first()
  const secondRelease = await second
  assert.equal(secondReady, true)
  assert.equal(gate.snapshot()[0]?.active, 1)
  secondRelease()
  assert.equal(gate.snapshot()[0]?.active, 0)
  gate.dispose()
})

test('interactive 优先于 background', async () => {
  const gate = new ModelGate({ maxConcurrentPerProvider: 1, waitMs: 500 })
  const first = await gate.acquire({ providerId: 'p' })
  const order: string[] = []
  const background = gate.acquire({ providerId: 'p', priority: 'background' })
    .then(release => { order.push('background'); return release })
  const interactive = gate.acquire({ providerId: 'p', priority: 'interactive' })
    .then(release => { order.push('interactive'); return release })

  first()
  const i = await interactive
  i()
  const b = await background
  assert.deepEqual(order, ['interactive', 'background'])
  b()
  gate.dispose()
})

test('429 后 provider 共享 cooldown', async () => {
  const gate = new ModelGate({
    maxConcurrentPerProvider: 1,
    waitMs: 1_000,
    cooldownBaseMs: 10,
    cooldownMaxMs: 100,
  })
  const first = await gate.acquire({ providerId: 'p' })
  first()
  gate.noteError('p', new ModelHttpError(429, 'rate limited', 50))

  const started = Date.now()
  const release = await gate.acquire({ providerId: 'p' })
  assert.ok(Date.now() - started >= 40, `cooldown too short: ${Date.now() - started}ms`)
  gate.noteSuccess('p')
  release()
  gate.dispose()
})

test('等待超时与 abort', async () => {
  const gate = new ModelGate({ maxConcurrentPerProvider: 1, waitMs: 30 })
  const first = await gate.acquire({ providerId: 'p' })
  await assert.rejects(gate.acquire({ providerId: 'p' }), /timeout/)
  first()

  const held = await gate.acquire({ providerId: 'p' })
  const controller = new AbortController()
  const waiting = gate.acquire({ providerId: 'p', signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await assert.rejects(waiting, /cancelled/)
  held()
  gate.dispose()
})
