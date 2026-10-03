import { test, expect, mock } from 'claude-code/testing'
import { cacheStatus } from './register.ts'

const MIN = 60_000
test('cacheStatus table', () => {
  expect(cacheStatus(undefined)).toEqual(undefined)
  expect(cacheStatus(0)).toEqual({ text: 'cache 60m', colour: 'green' })
  expect(cacheStatus(18 * MIN + 50_000)).toEqual({ text: 'cache 42m', colour: 'green' }) // 41m10s left
  expect(cacheStatus(51 * MIN)).toEqual({ text: '⚠ cache 9m', colour: 'yellow' })
  expect(cacheStatus(58 * MIN)).toEqual({ text: '‼ cache 2m', colour: 'red' })
  expect(cacheStatus(60 * MIN)).toEqual({ text: '❄ cache cold', colour: 'red' })
  expect(cacheStatus(61 * MIN)).toEqual({ text: '❄ cache cold', colour: 'red' })
})

const done = (e: { turnId: string; index: number }, stopReason: 'end_turn' | null = 'end_turn') =>
  ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason, usage: null })
async function drain<R>(g: AsyncGenerator<unknown, R>) {
  let r = await g.next()
  while (!r.done) r = await g.next()
  return r.value
}
const step = { turnId: 't', index: 0, model: 'm', messageCount: 1 }

test('main request starts the countdown; subagent and failed ones are ignored', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const shown: (string | undefined)[] = []
  on('ui.status', (_$, e) => { shown.push(e.text); return { value: undefined } as never })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let fail = false
  on('turn.step', async function* (_$, e) { return done(e, fail ? null : 'end_turn') })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(shown.at(-1)).toEqual(undefined)

  await drain($.turn.step({ ...step, agentId: 'sub' }))
  expect(shown.at(-1)).toEqual(undefined)

  fail = true
  await drain($.turn.step(step))
  expect(shown.at(-1)).toEqual(undefined)

  fail = false
  await drain($.turn.step(step))
  expect(shown.at(-1)).toEqual('cache 60m')

  await clock.advance(20 * MIN)
  expect(shown.at(-1)).toEqual('cache 40m')
  await clock.advance(40 * MIN)
  expect(shown.at(-1)).toEqual('❄ cache cold')
})

test('second session.start does not duplicate the interval', async ($, on) => {
  const clock = mock.clock(on)
  let n = 0
  on('ui.status', () => { n++; return { value: undefined } as never })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  n = 0
  await clock.advance(15_000)
  expect(n).toEqual(1)
})
