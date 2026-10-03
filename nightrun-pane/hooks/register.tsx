import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { parseRun } from './parse'
import type { RunFiles } from './parse'

const PANE = 'nightrun'
const isOpen = atom({ plugin: 'nightrun-pane', key: 'isOpen' } as const, false)
const REFRESH_MS = 30_000

type Fs = { read: (p: string) => Promise<unknown>; list: (p?: string) => Promise<{ name: string; kind: string }[]> }

const text = async (fs: Fs, p: string): Promise<string | undefined> => {
  try {
    const r = await fs.read(p)
    return typeof r === 'string' ? r : undefined
  } catch {
    return undefined
  }
}

// Read-only: only fs.read / fs.list. Every failure degrades to "less shown".
async function load(fs: Fs, cwd: string): Promise<RunFiles> {
  const root = `${cwd}/runtime/nightrun`
  let stamps: string[] = []
  try {
    stamps = (await fs.list(root)).filter(e => e.kind === 'dir').map(e => e.name).sort()
  } catch {
    // no runtime/nightrun
  }
  const stamp = stamps[stamps.length - 1] ?? null
  if (stamp === null) return { stamp, statuses: {}, hasSummary: false, hasStop: false }
  const dir = `${root}/${stamp}`
  let names: string[] = []
  try {
    names = (await fs.list(dir)).map(e => e.name)
  } catch {
    // unreadable dir
  }
  const statuses: Record<string, string> = {}
  for (const n of names.filter(n => n.endsWith('.status'))) {
    const t = await text(fs, `${dir}/${n}`)
    if (t !== undefined) statuses[n.slice(0, -'.status'.length)] = t
  }
  const hasSummary = names.includes('SUMMARY.md')
  return {
    stamp,
    log: await text(fs, `${dir}/nightrun.log`),
    statuses,
    hasSummary,
    hasStop: names.includes('STOP'),
    watcher: hasSummary ? undefined : await text(fs, `${cwd}/runtime/handoff/night-watch-state.md`),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nightrun',
      description: 'Show the newest night run (sprint states, log tail) in a pane',
    })
    // re-read every 30 s, but only while the pane is open
    $.clock.every(REFRESH_MS, async () => {
      if (await read($, isOpen)) $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('command.run', { command: 'nightrun' }, async $ => {
    await update($, isOpen, () => true)
    await $.ui.open({ id: PANE, title: 'Night run' })

    return { text: 'Night run pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isOpen, () => false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    let m
    try {
      m = parseRun(await load({ read: p => $.fs.read(p), list: p => $.fs.list(p) }, await $.session.cwd()))
    } catch (err) {
      return <Text color="red">nightrun: {String(err)}</Text>
    }
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const fit = (s: string) => (s.length > cols ? s.slice(0, Math.max(1, cols - 1)) + '…' : s)
    const header =
      m.status === 'NONE'
        ? 'No night runs in this project'
        : `${m.stamp} ${m.status}` +
          (m.branch ? `  ${m.branch} @ ${m.startedAt}` : '') +
          (m.isStopRequested ? '  STOP requested after current sprint' : '')

    return (
      <Box flexDirection="column">
        <Text bold>{fit(header)}</Text>
        {m.sprints.map(s => (
          <Box flexDirection="column">
            <Text>{fit(`${s.id}  ${s.level}  ${s.state}${s.elapsed ? `  ${s.elapsed}` : ''}`)}</Text>
            {s.note !== '' && <Text dimColor>{fit(`  ${s.note}`)}</Text>}
          </Box>
        ))}
        {m.watcher.length > 0 && <Text bold>Watcher</Text>}
        {m.watcher.map(l => (
          <Text dimColor>{fit(l)}</Text>
        ))}
        {m.tail.length > 0 && <Text bold>Log</Text>}
        {m.tail.map(l => (
          <Text dimColor>{fit(l)}</Text>
        ))}
        <Button key="refresh" label="Refresh" onPress={() => $.ui.invalidate('ui.render')} />
      </Box>
    )
  })
}
