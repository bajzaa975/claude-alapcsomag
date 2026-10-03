'use strict';
// session-signal.js: the hook that writes <id>.event.json / <id>.artifacts.jsonl (the status record
// contract, spec §6.5) on SessionStart, UserPromptSubmit, Notification, Stop, StopFailure, SessionEnd,
// and (from post-tool.js) PostToolUse. Fail-open: exit 0, no stdout, no stderr, never a throw.
const test = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const { NODE_DIR, runScript } = require('./helpers')
const sig = require('../session-signal.js')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'))
const SCRIPT = path.join(NODE_DIR, 'session-signal.js')

const run = (input, env = {}) => { const d = tmp(); sig.handle(input, env, 1759340000000, d); return d }
const ev = d => JSON.parse(fs.readFileSync(path.join(d, 's1.event.json')))

test('permission prompt -> needs_you with the message', () => {
  const d = run({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt',
                  message: 'Claude needs your permission to use Bash', cwd: 'D:/x ő' }, { ORCH_PANE_ID: 'p-3' })
  const e = ev(d)
  assert.equal(e.state, 'needs_you'); assert.equal(e.pane_id, 'p-3'); assert.equal(e.cwd, 'D:/x ő')
})
test('idle_prompt after Stop keeps done', () => {
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'Stop' }, {}, 1, d)
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }, {}, 2, d)
  assert.equal(ev(d).state, 'done')
})
test('idle_prompt mid-task -> needs_you', () => {
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'go' }, {}, 1, d)
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }, {}, 2, d)
  assert.equal(ev(d).state, 'needs_you')
})
test('Artifact PostToolUse appends url and title', () => {
  const d = run({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Artifact',
                  tool_input: { title: 'M1 to-dos' }, tool_response: { text: 'Published https://claude.ai/code/artifact/abc' } })
  const line = JSON.parse(fs.readFileSync(path.join(d, 's1.artifacts.jsonl'), 'utf8').trim())
  assert.equal(line.url, 'https://claude.ai/code/artifact/abc'); assert.equal(line.title, 'M1 to-dos')
})
test('answering a permission prompt resumes working', () => {
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash?' }, {}, 1, d)
  sig.handle({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} }, {}, 2, d)
  assert.equal(ev(d).state, 'working')
})
test('PostToolUse on a non-Artifact tool while working writes nothing', () => {
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'go' }, {}, 1, d)
  const before = fs.readFileSync(path.join(d, 's1.event.json'), 'utf8')
  sig.handle({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {} }, {}, 2, d)
  assert.equal(fs.readFileSync(path.join(d, 's1.event.json'), 'utf8'), before)
})
test('unsafe session id writes nothing; malformed input never throws', () => {
  const d = run({ session_id: '../evil', hook_event_name: 'Stop' }); assert.deepEqual(fs.readdirSync(d), [])
  assert.doesNotThrow(() => sig.handle(null, {}, 1, tmp()))
})
test('SessionStart prunes files older than 7 days', () => {
  const d = tmp(); const f = path.join(d, 'old.event.json'); fs.writeFileSync(f, '{}')
  const t = (1759340000000 - 8 * 86400e3) / 1000; fs.utimesSync(f, t, t)
  sig.handle({ session_id: 's1', hook_event_name: 'SessionStart' }, {}, 1759340000000, d)
  assert.deepEqual(fs.readdirSync(d).sort(), ['s1.event.json'])
})

// --- beyond the plan's list: every table row, the record shape, the rules' edges ---

test('every row of the contract table: event, state and message (cuts at 120 / 500 characters)', () => {
  const long = 'x'.repeat(700)
  for (const [input, state, message] of [
    [{ hook_event_name: 'SessionStart', source: 'startup' }, 'appears', 'started'],
    [{ hook_event_name: 'UserPromptSubmit', prompt: 'p'.repeat(200) }, 'working', 'p'.repeat(120)],
    [{ hook_event_name: 'UserPromptSubmit', prompt: '\u{1F600}'.repeat(200) }, 'working', '\u{1F600}'.repeat(120)],
    [{ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: long }, 'needs_you', 'x'.repeat(500)],
    [{ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'm' }, 'needs_you', 'm'],
    [{ hook_event_name: 'Stop' }, 'done', ''],
    [{ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429', last_assistant_message: 'API Error: Rate limit reached' }, 'problem', 'API Error: Rate limit reached'],
    [{ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: long }, 'problem', 'x'.repeat(500)],
    [{ hook_event_name: 'StopFailure', error: 'overloaded' }, 'problem', 'overloaded'],
    [{ hook_event_name: 'SessionEnd', reason: 'logout' }, 'closed', 'logout'],
  ]) {
    const e = ev(run({ session_id: 's1', ...input }))
    assert.deepEqual([e.event, e.state, e.message], [input.hook_event_name, state, message], JSON.stringify(input).slice(0, 80))
  }
})

test('a record carries exactly the contract fields: v, ppid, entrypoint, pane_id when set, ts in seconds', () => {
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash?',
    cwd: 'D:/x', transcript_path: 'D:/t.jsonl', title: 'ignored' }, { ORCH_PANE_ID: 'p-3', CLAUDE_CODE_ENTRYPOINT: 'cli' }, 1759340000999, d)
  assert.deepEqual(ev(d), { v: 1, session_id: 's1', event: 'Notification', state: 'needs_you', message: 'Bash?',
    notification_type: 'permission_prompt', cwd: 'D:/x', transcript_path: 'D:/t.jsonl', ppid: process.ppid, pane_id: 'p-3',
    entrypoint: 'cli', ts: 1759340000 })
  sig.handle({ session_id: 's1', hook_event_name: 'Stop' }, {}, 1759340001000, d)
  assert.deepEqual(ev(d), { v: 1, session_id: 's1', event: 'Stop', state: 'done', message: '', cwd: '', transcript_path: '',
    ppid: process.ppid, entrypoint: '', ts: 1759340001 })
})

test('other notification types and unknown events write nothing; idle_prompt after SessionStart keeps appears', () => {
  for (const input of [{ hook_event_name: 'Notification', notification_type: 'auth_success', message: 'x' },
    { hook_event_name: 'Notification', message: 'no type' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash' }]) {
    assert.deepEqual(fs.readdirSync(run({ session_id: 's1', ...input })), [], JSON.stringify(input))
  }
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'SessionStart' }, {}, 1, d)
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }, {}, 2, d)
  assert.equal(ev(d).state, 'appears')
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash?' }, {}, 3, d)
  assert.equal(ev(d).state, 'needs_you')                     // the idle rule is for idle_prompt only
})

test('resume rule: the rewrite is a whole working record (event PostToolUse, message resumed); Artifact resumes too', () => {
  const d = tmp()
  sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash?' }, {}, 1000, d)
  sig.handle({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input: {}, tool_response: 'none', cwd: 'D:/y' }, {}, 2000, d)
  const e = ev(d)
  assert.deepEqual([e.event, e.state, e.message, e.cwd, e.ts, 'notification_type' in e], ['PostToolUse', 'working', 'resumed', 'D:/y', 2, false])
})

test('Artifact: no claude.ai URL appends nothing; title falls back to the file basename; trailing punctuation is not part of the url', () => {
  const art = (tool_input, tool_response) => run({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input, tool_response })
  assert.deepEqual(fs.readdirSync(art({ title: 't' }, { text: 'see https://example.com/a' })), [])
  const d = art({ file_path: path.join('D:', 'w', 'todo.html') }, 'Published at https://claude.ai/code/artifact/x-1.')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 's1.artifacts.jsonl'), 'utf8')),
    { v: 1, url: 'https://claude.ai/code/artifact/x-1', title: 'todo.html', ts: 1759340000 })
})

test('garbage input, env and dir never throw', () => {
  const file = path.join(tmp(), 'file'); fs.writeFileSync(file, 'x')
  for (const input of [undefined, 0, 'x', [], {}, { session_id: 1 }, { session_id: 's1' }, { session_id: 's1', hook_event_name: 42 },
    { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: { a: 1 } },
    { session_id: 's1', hook_event_name: 'Notification', notification_type: ['idle_prompt'], message: 7 },
    { session_id: 's1', hook_event_name: 'StopFailure', error: null, last_assistant_message: [] },
    { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input: 'x', tool_response: null },
    { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input: { title: 5, file_path: {} }, tool_response: 'https://claude.ai/a' },
    { session_id: 'a'.repeat(129), hook_event_name: 'Stop' }]) {
    assert.doesNotThrow(() => sig.handle(input, {}, 1, tmp()), JSON.stringify(input))
  }
  for (const dir of [undefined, null, 42, file, path.join(file, 'x')]) {
    for (const hook_event_name of ['SessionStart', 'Stop', 'PostToolUse']) {
      assert.doesNotThrow(() => sig.handle({ session_id: 's1', hook_event_name, tool_name: 'Artifact', tool_response: 'https://claude.ai/a' }, {}, 1, dir))
    }
  }
  assert.doesNotThrow(() => sig.handle({ session_id: 's1', hook_event_name: 'Stop' }, null, 1, tmp()))
  assert.doesNotThrow(() => sig.sample({ a: 1 }, null))
})

test('CLI: exit 0, empty stdout and stderr on any stdin, an unsafe id or an unwritable status dir', () => {
  const d = tmp(); const file = path.join(d, 'file'); fs.writeFileSync(file, 'x')
  for (const [stdin, dir] of [['', d], ['not json', d], ['[]', d], ['null', d], ['{"session_id":', d],
    [JSON.stringify({ session_id: '../evil', hook_event_name: 'Stop' }), d],
    [JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }), file],
    [JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }), path.join(file, 'sub')],
    [JSON.stringify({ session_id: 's2', hook_event_name: 'Stop' }), d]]) {
    const r = runScript(SCRIPT, stdin, { BAJZI_STATUS_DIR: dir })
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], `${stdin} -> ${dir}`)
  }
  assert.deepEqual(fs.readdirSync(d).sort(), ['file', 's2.event.json'])
  const def = runScript(SCRIPT, JSON.stringify({ session_id: 's3', hook_event_name: 'SessionStart' }), { BAJZI_STATUS_DIR: undefined, BAJZI_HOME: undefined })
  assert.equal(JSON.parse(fs.readFileSync(path.join(def.home, '.claude', 'bajzi', 'sessions', 's3.event.json'), 'utf8')).state, 'appears')
})

test('CLI with lib/session-status.js missing (partial install) exits 0 silently and logs', () => {
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'lib'))
  fs.copyFileSync(SCRIPT, path.join(dir, 'session-signal.js'))
  fs.copyFileSync(path.join(NODE_DIR, 'lib', 'hook-io.js'), path.join(dir, 'lib', 'hook-io.js'))
  const r = runScript(path.join(dir, 'session-signal.js'), JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }))
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
  assert.match(fs.readFileSync(path.join(r.home, '.claude', 'bajzi', 'hook-errors.log'), 'utf8'), / session-signal Cannot find module/)
})

test('hooks.json wires session-signal.js on the six events, timeout 5, Notification on the four types, never on PostToolUse', () => {
  const h = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '..', 'hooks.json'), 'utf8')).hooks
  const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/node/session-signal.js"'
  const wired = Object.entries(h).flatMap(([e, a]) => a.filter(m => m.hooks.some(k => k.command === CMD)).map(m => [e, m]))
  assert.deepEqual(wired.map(([e]) => e).sort(), ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'])
  for (const [e, m] of wired) assert.deepEqual(m.hooks, [{ type: 'command', command: CMD, timeout: 5 }], e)
  assert.equal(wired.find(([e]) => e === 'Notification')[1].matcher, 'permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input')
  for (const [e, m] of wired) if (e !== 'Notification') assert.equal(m.matcher, undefined, e)
})

// --- resume rule owner match: agent_id (sub-agent) vs no agent_id (main thread); agent_type is never a marker ---

const note = (d, extra = {}, t = 1) => sig.handle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash?', ...extra }, {}, t, d)
const tool = (d, extra = {}, t = 2) => sig.handle({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {}, ...extra }, {}, t, d)

test('resume: a sub-agent tool call never resumes a main-thread prompt; a main-thread one does', () => {
  const d = tmp(); note(d)
  assert.equal('agent_id' in ev(d), false)
  tool(d, { agent_id: 'a1' })
  assert.deepEqual([ev(d).state, ev(d).message], ['needs_you', 'Bash?'])
  tool(d)
  assert.deepEqual([ev(d).state, ev(d).message, 'agent_id' in ev(d)], ['working', 'resumed', false])
})

test('resume: a sub-agent prompt stores agent_id; only that sub-agent\'s tool call resumes it', () => {
  const d = tmp(); note(d, { agent_id: 'a1' })
  assert.deepEqual([ev(d).state, ev(d).agent_id], ['needs_you', 'a1'])
  tool(d); assert.equal(ev(d).state, 'needs_you')
  tool(d, { agent_id: 'a2' }); assert.equal(ev(d).state, 'needs_you')
  tool(d, { agent_id: 'a1' })
  assert.deepEqual([ev(d).state, ev(d).message, 'agent_id' in ev(d)], ['working', 'resumed', false])
})

test('resume: agent_type alone (no agent_id) and an empty / non-string agent_id count as the main thread', () => {
  const d = tmp(); note(d, { agent_type: 'reviewer', agent_id: '' })
  assert.equal('agent_id' in ev(d), false)
  tool(d, { agent_type: 'reviewer' }); assert.equal(ev(d).state, 'working')
  const d2 = tmp(); note(d2, { agent_id: 'a1' })
  tool(d2, { agent_type: 'a1' }); assert.equal(ev(d2).state, 'needs_you')
  tool(d2, { agent_id: 7 }); assert.equal(ev(d2).state, 'needs_you')
  const d3 = tmp(); note(d3, { agent_id: ['a1'] })
  assert.equal('agent_id' in ev(d3), false)
  tool(d3, { agent_id: '' }); assert.equal(ev(d3).state, 'working')
})

test('samples: <home>/.claude/bajzi/hook-samples.on -> one redacted JSON line per call (shape, never content); off -> nothing', () => {
  const home = tmp(); const b = path.join(home, '.claude', 'bajzi'); const out = path.join(b, 'hook-samples.jsonl')
  const input = { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', transcript_path: '\u00e9'.repeat(3000),
    tool_input: { command: 'export API_KEY=sk-SECRET-123', timeout: 5000, run_in_background: false },
    tool_response: { stdout: 'token ghp_SECRETTOKEN', interrupted: false, list: ['x\u{1F600}', 7, null, { k: 'hunter3' }] },
    prompt: 'my password is hunter2', model: { id: 'claude-x' }, n: 1 }
  sig.sample(input, { BAJZI_HOME: home })
  assert.equal(fs.existsSync(out), false)
  fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'hook-samples.on'), '')
  sig.sample(input, { BAJZI_HOME: home })
  const raw = fs.readFileSync(out, 'utf8'); const lines = raw.split('\n')
  assert.equal(lines.length, 2); assert.equal(lines[1], '')
  for (const s of ['sk-SECRET-123', 'ghp_SECRETTOKEN', 'hunter2', 'hunter3', 'API_KEY', 'claude-x']) assert.equal(raw.includes(s), false, s)
  assert.deepEqual(JSON.parse(lines[0]), { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', transcript_path: '\u00e9'.repeat(2048),
    tool_input: { command: '<str 28>', timeout: 5000, run_in_background: false },
    tool_response: { stdout: '<str 21>', interrupted: false, list: ['<str 3>', 7, null, { k: '<str 7>' }] },
    prompt: '<str 22>', model: { id: '<str 8>' }, n: 1 })
  sig.sample(['top', 1], { BAJZI_HOME: home })
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8').split('\n')[1]), ['<str 3>', 1])
  fs.writeFileSync(out, '')
  const r = runScript(SCRIPT, JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }), { HOME: home, BAJZI_HOME: home, BAJZI_STATUS_DIR: tmp() })
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8').split('\n')[0]), { session_id: 's1', hook_event_name: 'Stop' })
})
