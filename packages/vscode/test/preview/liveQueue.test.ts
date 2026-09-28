import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveQueue } from '../../src/preview/liveQueue'

const turn = () => new Promise(resolve => setImmediate(resolve))
test('continuous requests finish the running revision, then run only the newest pending revision', async () => {
  const queue = new LiveQueue<number>()
  let complete!: (value: number) => void
  const ran: number[] = []
  const first = queue.request('root', () => new Promise(resolve => { ran.push(1); complete = resolve }))
  await turn()
  const second = queue.request('root', async () => { ran.push(2); return 2 })
  const third = queue.request('root', async () => { ran.push(3); return 3 })
  await turn()
  assert.deepEqual(ran, [1], 'running work must not be cancelled')
  complete(1)
  assert.deepEqual(await Promise.all([first, second, third]), [1, 3, 3])
  assert.deepEqual(ran, [1, 3])
})

test('closing cancels pending work and a rejected run does not wedge the queue', async () => {
  const queue = new LiveQueue<number>()
  let complete!: (value: number) => void
  const first = queue.request('root', () => new Promise(resolve => { complete = resolve }))
  await turn()
  const pending = queue.request('root', async () => 2)
  queue.cancel('root')
  assert.equal(await pending, undefined)
  complete(1)
  assert.equal(await first, 1)
  await assert.rejects(queue.request('root', async () => { throw new Error('failed') }), /failed/)
  assert.equal(await queue.request('root', async () => 3), 3)
})
