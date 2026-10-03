import { test, expect, mock } from 'claude-code/testing'
import { load } from './register.tsx'

const ROOT = '/p/runtime/nightrun'
type Ent = { name: string; kind: string }
const dir = (...n: string[]): Ent[] => n.map(name => ({ name, kind: 'dir' }))
const file = (...n: string[]): Ent[] => n.map(name => ({ name, kind: 'file' }))

function setup($: any, on: any, tree: Record<string, Ent[]>, files: Record<string, string>) {
  const reads: string[] = []
  const calls = { invalidate: 0, opened: 0 }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('command.register', () => ({ value: undefined }))
  on('fs.list', (_$: any, e: any) => {
    if (!(e.path in tree)) throw new Error('ENOENT')
    return { value: tree[e.path] }
  })
  on('fs.read', (_$: any, e: any) => {
    reads.push(e.path)
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('ui.open', () => { calls.opened++; return { value: undefined } })
  on('ui.invalidate', () => { calls.invalidate++; return { value: undefined } })
  return { reads, calls }
}

test('second session.start does not duplicate the interval; /nightrun opens the pane', async ($, on) => {
  const clock = mock.clock(on)
  const { calls } = setup($, on, {}, {})
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  await clock.advance(30_000)
  expect(calls.invalidate).toEqual(0) // pane closed

  await $.command.run({ command: 'nightrun', args: '' })
  expect(calls.opened).toEqual(1)
  await clock.advance(30_000)
  expect(calls.invalidate).toEqual(1) // one interval, not two
})

function fakeFs(tree: Record<string, Ent[]>, files: Record<string, string>) {
  const reads: string[] = []
  return {
    reads,
    list: async (p?: string) => { if (!(p! in tree)) throw new Error('ENOENT'); return tree[p!] },
    read: async (p: string) => { reads.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p] },
  }
}
const W = '/p/runtime/handoff/night-watch-state.md'

test('load: newest stamp, only .status files, SUMMARY/STOP flags; watcher read only without summary', async () => {
  const tree = {
    [ROOT]: [...dir('20261001-100000', '20261002-163056'), ...file('stray')],
    [`${ROOT}/20261002-163056`]: file('nightrun.log', 'SPRINT-1.status', 'other.txt', 'STOP'),
    [`${ROOT}/20261001-100000`]: file('SUMMARY.md'),
  }
  const files = {
    [`${ROOT}/20261002-163056/nightrun.log`]: 'LOG',
    [`${ROOT}/20261002-163056/SPRINT-1.status`]: 'PARKED',
    [`${ROOT}/20261002-163056/other.txt`]: 'no',
    [W]: 'WATCH',
  }
  const fs = fakeFs(tree, files)
  const r = await load(fs, '/p')
  expect(r.stamp).toEqual('20261002-163056')
  expect(r.statuses).toEqual({ 'SPRINT-1': 'PARKED' })
  expect(r.hasSummary).toEqual(false)
  expect(r.hasStop).toEqual(true)
  expect(r.log).toEqual('LOG')
  expect(r.watcher).toEqual('WATCH')
  expect(fs.reads).not.toContain(`${ROOT}/20261002-163056/other.txt`)

  // newest stamp has SUMMARY.md: watcher file is not read
  const tree2 = { [ROOT]: dir('20261002-163056'), [`${ROOT}/20261002-163056`]: file('SUMMARY.md', 'nightrun.log') }
  const fs2 = fakeFs(tree2, { ...files })
  const r2 = await load(fs2, '/p')
  expect(r2.hasSummary).toEqual(true)
  expect(r2.hasStop).toEqual(false)
  expect(r2.watcher).toEqual(undefined)
  expect(fs2.reads).not.toContain(W)

  // no runtime/nightrun at all
  const r3 = await load(fakeFs({}, {}), '/p')
  expect(r3.stamp).toEqual(null)
})
