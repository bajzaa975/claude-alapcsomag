import { test, expect } from 'claude-code/testing'
import { parseRun } from './parse'
import type { RunFiles } from './parse'

const START = '[16:30:58] started on workspace at 4f8363e... (tag nightrun-start-20261002-163056)'
const L172 = [
  '[16:50:18] SPRINT-172 level L0 (claude) via claude',
  '[16:50:18] SPRINT-172 [main] session start (attempt 1)',
  '[19:14:21] SPRINT-172 => PARKED (8 commits) ' + 'x'.repeat(200),
]
const L173 = [
  '[19:20:00] SPRINT-173 level L0 (claude) via claude',
  '[19:20:00] SPRINT-173 [main] session start (attempt 1)',
  '[20:30:00] SPRINT-173 => PARKED (2 commits) short note',
]
const base: RunFiles = { stamp: '20261002-163056', statuses: {}, hasSummary: false, hasStop: false }

test('finished run, two PARKED sprints', async () => {
  const m = parseRun({
    ...base,
    log: [START, ...L172, ...L173, '[20:24:35] summary: runtime/nightrun/20261002-163056/SUMMARY.md'].join('\n'),
    statuses: { 'SPRINT-172': 'PARKED\nstatus note\nreviews: rounds=2 C=3 I=7 M=4\n' },
    hasSummary: true,
  })
  expect(m.status).toBe('FINISHED')
  expect(m.branch).toBe('workspace')
  expect(m.startedAt).toBe('16:30:58')
  expect(m.sprints.map(s => [s.id, s.level, s.state, s.elapsed])).toEqual([
    ['SPRINT-172', 'L0 (claude)', 'PARKED', '2h24m'],
    ['SPRINT-173', 'L0 (claude)', 'PARKED', '1h10m'],
  ])
  expect(m.sprints[0]?.note).toBe('status note')
  expect(m.sprints[1]?.note).toBe('short note')
  expect(m.tail.length).toBe(8)
})

test('log note is truncated to 120', async () => {
  const m = parseRun({ ...base, log: [START, ...L172].join('\n') })
  expect(m.sprints[0]?.note.length).toBe(120)
})

test('running run: last sprint has session start but no =>', async () => {
  const m = parseRun({
    ...base,
    log: [
      START,
      ...L172,
      '[19:20:00] SPRINT-173 level L0 (claude) via claude',
      '[19:20:00] SPRINT-173 [main] session start (attempt 1)',
      '[19:21:00] SPRINT-174 level L0 (claude) via claude',
    ].join('\n'),
    watcher: 'a\nb\nc\nd\ne\nf\ng',
  })
  expect(m.status).toBe('RUNNING')
  expect(m.sprints.map(s => s.state)).toEqual(['PARKED', 'running', 'queued'])
  expect(m.watcher).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('STOP present', async () => {
  expect(parseRun({ ...base, log: START, hasStop: true }).isStopRequested).toBe(true)
})

test('empty dir and missing runtime/nightrun', async () => {
  const e = parseRun(base)
  expect(e.status).toBe('RUNNING')
  expect(e.sprints).toEqual([])
  expect(e.tail).toEqual([])
  expect(parseRun({ stamp: null, statuses: {}, hasSummary: false, hasStop: false }).status).toBe('NONE')
})
