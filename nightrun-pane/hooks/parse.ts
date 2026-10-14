export type RunFiles = {
  /** newest stamp dir name, or null when runtime/nightrun is missing/empty */
  stamp: string | null
  /** nightrun.log text, if readable */
  log?: string
  /** sprint id -> raw .status text */
  statuses: Record<string, string>
  hasSummary: boolean
  hasStop: boolean
  /** night-watch-state.md text, if readable */
  watcher?: string
}

export type SprintRow = {
  id: string
  level: string
  state: string
  elapsed: string
  note: string
}

export type RunModel = {
  stamp: string | null
  status: 'NONE' | 'RUNNING' | 'FINISHED'
  branch: string
  startedAt: string
  isStopRequested: boolean
  sprints: SprintRow[]
  tail: string[]
  watcher: string[]
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const secs = (t: string) => {
  const [h = 0, m = 0, s = 0] = t.split(':').map(Number)
  return h * 3600 + m * 60 + s
}
export const fmtElapsed = (from: string, to: string) => {
  let d = secs(to) - secs(from)
  if (d < 0) d += 86400 // log has only HH:MM:SS; one midnight wrap assumed
  const h = Math.floor(d / 3600)
  const m = Math.floor((d % 3600) / 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

const LINE = /^\[(\d\d:\d\d:\d\d)\] (SPRINT-\d+)\b\s*(.*)$/
const STARTED = /^\[(\d\d:\d\d:\d\d)\] started on (\S+) at/

export function parseRun(files: RunFiles): RunModel {
  const lines = (files.log ?? '').split(/\r?\n/).filter(l => l.trim() !== '')
  const rows = new Map<string, SprintRow & { start?: string; end?: string; logState?: string; logNote?: string }>()
  let branch = ''
  let startedAt = ''
  let hasSummaryLine = false
  for (const l of lines) {
    const s = STARTED.exec(l)
    if (s) {
      startedAt = s[1] ?? ''
      branch = s[2] ?? ''
      continue
    }
    if (/^\[[\d:]+\] summary:/.test(l)) hasSummaryLine = true
    const m = LINE.exec(l)
    if (!m) continue
    const [, time = '', id = '', rest = ''] = m
    let r = rows.get(id)
    if (!r) {
      r = { id, level: '', state: '', elapsed: '', note: '' }
      rows.set(id, r)
    }
    const lvl = /^level (L\d \([^)]*\))/.exec(rest)
    if (lvl) r.level = lvl[1] ?? ''
    if (/^\[main\] session start/.test(rest) && !r.start) r.start = time
    const done = /^=> (\w+)(?: \(\d+ commits?\))?\s*(.*)$/.exec(rest)
    if (done) {
      r.end = time
      r.logState = done[1]
      r.logNote = done[2]
    }
  }
  const sprints = [...rows.values()].map<SprintRow>(r => {
    const st = (files.statuses[r.id] ?? '').split(/\r?\n/)
    const fileState = (st[0] ?? '').trim()
    const fileNote = (st[1] ?? '').trim()
    const state = fileState || r.logState || (r.start && !r.end ? 'running' : 'queued')
    return {
      id: r.id,
      level: r.level,
      state,
      elapsed: r.start && r.end ? fmtElapsed(r.start, r.end) : '',
      note: cut(fileNote || r.logNote || '', 120),
    }
  })
  const isFinished = files.hasSummary || hasSummaryLine
  const status = files.stamp === null ? 'NONE' : isFinished ? 'FINISHED' : 'RUNNING'
  return {
    stamp: files.stamp,
    status,
    branch,
    startedAt,
    isStopRequested: files.hasStop,
    sprints,
    tail: lines.slice(-8).map(l => cut(l, 160)),
    watcher: status === 'RUNNING' && files.watcher ? files.watcher.split(/\r?\n/).slice(0, 5).map(l => cut(l, 160)) : [],
  }
}
