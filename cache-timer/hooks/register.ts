import type { EngineInterface, Register } from 'claude-code'

// Prompt-cache TTL in minutes. It is 5 when the account is in usage overage; a mod cannot detect that.
export const TTL_MIN = 60
const TICK_MS = 15_000

export type Colour = 'green' | 'yellow' | 'red'

// Pure: ms since the last main-thread request -> status text + colour.
// `$.ui.status` takes plain text only, so a leading symbol stands in for the colour.
export function cacheStatus(elapsedMs: number | undefined): { text: string; colour: Colour } | undefined {
  if (elapsedMs === undefined) return undefined
  const left = TTL_MIN - elapsedMs / 60_000
  if (left <= 0) return { text: '❄ cache cold', colour: 'red' }
  const colour: Colour = left < 3 ? 'red' : left < 10 ? 'yellow' : 'green'
  const mark = colour === 'red' ? '‼ ' : colour === 'yellow' ? '⚠ ' : ''
  return { text: `${mark}cache ${Math.ceil(left)}m`, colour }
}

async function show($: EngineInterface, last: number | undefined) {
  $.ui.status(cacheStatus(last === undefined ? undefined : (await $.clock.now()) - last)?.text)
}

export const register: Register = on => {
  let lastMs: number | undefined
  let stop: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    stop?.cancel()
    lastMs = undefined
    stop = $.clock.every(TICK_MS, () => void show($, lastMs))
    $.ui.status(undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined && r.stopReason !== null) {
      lastMs = await $.clock.now()
      await show($, lastMs)
    }
    return r
  })
}
