#!/usr/bin/env node
'use strict';
// bajzi radar: a biweekly, local, READ-ONLY review of the owner's Claude setup (spec §6.14).
// Node stdlib only. CLI: node radar.js <digest|run|notice|seen|install-task>
// Only this script writes, and only inside the state dir; the headless session it starts has
// read-only tools (claudeArgs) and the usage digest it gets carries counts, never text.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DAY = 864e5;
const RO_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
const REPORT = /^\d{4}-\d{2}-\d{2}(-\d+)?\.md$/;
const DENIAL = ['Permission to use', 'denied by', "doesn't want to proceed"];
const DAYRUN = /^(\S+)\s+(\S+)\s+model=(\S+)\s+rounds=(\d+)\s+result=(\S+)(?:\s|$)/;
// Every label the digest emits passes this, else it is "(other)": the fields are model- or
// file-controlled, and free text (spaces, quotes, =) must never reach the output.
const LABEL = /^[A-Za-z0-9:_.@/<>-]{1,64}$/;
const label = v => (typeof v === 'string' && LABEL.test(v) ? v : '(other)');
// DAY-RUN tokens often carry a detail suffix (review(s157-s1), pass(CLEAN)): keep the leading word.
const head = v => label((/^[A-Za-z0-9_.:@/-]+/.exec(v) || [''])[0]);
const basename = cwd => (cwd.split(/[\\/]/).filter(Boolean).pop() || '').replace(/[\x00-\x1f]/g, '').slice(0, 64) || '(other)';
const iso = t => new Date(t).toISOString();
const num = v => (Number.isFinite(v) ? v : 0);
const inc = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

function stateDir(env = process.env) {
  return env.BAJZI_RADAR_HOME || path.join(os.homedir(), '.claude', 'bajzi', 'radar');
}

function ymd(t) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) fn(l);
}

// <projectsDir>/*/*.jsonl and <projectsDir>/*/*/subagents/*.jsonl, mtime >= since.
function transcripts(dir, since) {
  const out = [];
  for (const p of ls(dir)) {
    if (!p.isDirectory()) continue;
    const pd = path.join(dir, p.name);
    for (const e of ls(pd)) {
      const ep = path.join(pd, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(ep);
      else if (e.isDirectory()) {
        const sd = path.join(ep, 'subagents');
        for (const s of ls(sd)) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(path.join(sd, s.name));
      }
    }
  }
  return out.filter(f => (mtime(f) ?? -Infinity) >= since);
}

function newState() {
  return {
    files: 0, entries: 0, malformed: 0, denials: 0, cwds: new Set(),
    projects: new Map(), models: new Map(), msgIds: new Set(), toolName: new Map(), counted: new Set(),
    tools: new Map(), skills: new Map(), agentTypes: new Map(), agentModels: new Map(), errors: new Map(),
    commands: new Map(), comp: new Map(),
  };
}

function commandsIn(st, text) {
  for (const m of text.matchAll(/<command-name>([^<]{1,200})<\/command-name>/g)) inc(st.commands, label(m[1].trim()));
}

function entry(st, o, since) {
  const msg = o.message && typeof o.message === 'object' ? o.message : null;
  const content = msg ? msg.content : null;
  // tool_use id -> name is registered for every line read, so an in-window error whose call
  // predates the window still gets its tool name.
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) if (b && b.type === 'tool_use' && typeof b.id === 'string') st.toolName.set(b.id, b.name);
  }
  const ts = Date.parse(o.timestamp);
  if (!(ts >= since)) return;
  st.entries++;
  const sid = typeof o.sessionId === 'string' ? o.sessionId : '';
  if (typeof o.cwd === 'string' && o.cwd) {
    st.cwds.add(o.cwd);
    if (sid) {
      const b = basename(o.cwd);
      if (!st.projects.has(b)) st.projects.set(b, new Set());
      st.projects.get(b).add(sid);
    }
  }
  if (o.type === 'assistant' && msg) {
    // Claude Code writes one line per content block, each repeating message.id and usage.
    const id = typeof msg.id === 'string' ? msg.id : null;
    if (!id || !st.msgIds.has(id)) {
      if (id) st.msgIds.add(id);
      const k = msg.model ? label(msg.model) : '(none)';
      const r = st.models.get(k) || { msgs: 0, in: 0, out: 0, cr: 0, cw: 0 };
      const u = msg.usage || {};
      r.msgs++;
      r.in += num(u.input_tokens); r.out += num(u.output_tokens);
      r.cr += num(u.cache_read_input_tokens); r.cw += num(u.cache_creation_input_tokens);
      st.models.set(k, r);
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || st.counted.has(b.id)) continue;
        if (typeof b.id === 'string') st.counted.add(b.id);
        inc(st.tools, label(b.name));
        const inp = b.input && typeof b.input === 'object' ? b.input : {};
        if (b.name === 'Skill') inc(st.skills, label(inp.skill));
        if (b.name === 'Agent' || b.name === 'Task') {
          inc(st.agentTypes, inp.subagent_type ? label(inp.subagent_type) : '(none)');
          inc(st.agentModels, inp.model ? label(inp.model) : 'inherit');
        }
      }
    }
  }
  if (o.type === 'user' && msg) {
    if (typeof content === 'string') commandsIn(st, content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') commandsIn(st, b.text);
        if (b.type === 'tool_result' && b.is_error === true) {
          inc(st.errors, label(st.toolName.get(b.tool_use_id) || 'unknown'));
          const t = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '';
          if (DENIAL.some(d => t.includes(d))) st.denials++;
        }
      }
    }
  }
  const boundary = o.type === 'system' && o.subtype === 'compact_boundary';
  if (boundary || o.isCompactSummary === true) {
    // One compaction may write both markers: count the larger of the two per session.
    const r = st.comp.get(sid) || { b: 0, s: 0 };
    if (boundary) r.b++; else r.s++;
    st.comp.set(sid, r);
  }
}

async function dayRun(cwds, since) {
  const dr = { runs: new Map(), results: new Map(), malformed: 0 };
  const done = new Set();
  for (const cwd of cwds) {
    if (!path.isAbsolute(cwd)) continue;
    const f = path.join(cwd, 'runtime', 'DAY-RUN.log');
    if (done.has(f) || mtime(f) === null) continue;
    done.add(f);
    try {
      await eachLine(f, l => {
        const s = l.trim();
        if (!s) return;
        const m = DAYRUN.exec(s);
        const t = m ? Date.parse(m[1]) : NaN;
        if (Number.isNaN(t)) { dr.malformed++; return; }
        if (t < since) return;
        const k = head(m[2]) + ' x ' + head(m[3]);
        const r = dr.runs.get(k) || { n: 0, rounds: 0 };
        r.n++; r.rounds += Number(m[4]);
        dr.runs.set(k, r);
        inc(dr.results, head(m[5]));
      });
    } catch { /* unreadable log: skipped */ }
  }
  return dr;
}

const byCount = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const rows = (m, n) => [...m].sort(byCount).slice(0, n).map(([k, v]) => `- ${k}: ${v}`);

function render(st, dr, since, now) {
  const L = ['## Usage digest (counts only)', `window: ${iso(since)} .. ${iso(now)}`,
    `transcript files: ${st.files} · entries counted: ${st.entries} · malformed lines: ${st.malformed}`];
  const sec = (title, r) => L.push('', '### ' + title, ...(r.length ? r : ['- none']));
  sec('sessions per project (top 10)', rows(new Map([...st.projects].map(([k, s]) => [k, s.size])), 10));
  sec('assistant messages per model', [...st.models].sort((a, b) => b[1].msgs - a[1].msgs || (a[0] < b[0] ? -1 : 1)).slice(0, 10)
    .map(([k, r]) => `- ${k}: ${r.msgs} msgs · in ${r.in} · out ${r.out} · cache_read ${r.cr} · cache_write ${r.cw}`));
  sec('tool uses (top 15)', rows(st.tools, 15));
  sec('skills', rows(st.skills, 10));
  sec('agent dispatches by subagent_type', rows(st.agentTypes, 10));
  sec('agent dispatches by model', rows(st.agentModels, 10));
  sec('tool errors by tool', rows(st.errors, 10));
  sec('permission denials (approximate)', [`- ${st.denials}`]);
  sec('slash commands', rows(st.commands, 10));
  sec('compactions', [`- ${[...st.comp.values()].reduce((n, r) => n + Math.max(r.b, r.s), 0)}`]);
  const res = [...dr.results].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  sec('DAY-RUN (task-class x model)', [
    ...[...dr.runs].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([k, r]) => `- ${k}: ${r.n} runs · ${r.rounds} rounds`),
    `- results: ${res}`, `- malformed lines: ${dr.malformed}`]);
  return L.slice(0, 150).join('\n') + '\n';
}

async function digest({ projectsDir, since, now = Date.now() }) {
  const s = +since, st = newState();
  for (const f of transcripts(projectsDir, s)) {
    st.files++;
    try {
      await eachLine(f, l => {
        if (!l.trim()) return;
        let o;
        try { o = JSON.parse(l); } catch { st.malformed++; return; }
        if (!o || typeof o !== 'object') { st.malformed++; return; }
        entry(st, o, s);
      });
    } catch { /* unreadable transcript: skipped */ }
  }
  return render(st, await dayRun(st.cwds, s), s, +now);
}

function listReports(state) {
  const d = path.join(state, 'reports');
  return ls(d).filter(e => e.isFile() && REPORT.test(e.name))
    .map(e => ({ path: path.join(d, e.name), mtimeMs: mtime(path.join(d, e.name)) }))
    .filter(r => r.mtimeMs !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function bajziRoot(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    return j.plugins['bajzi@bajzi-plugins'][0].installPath || null;
  } catch { return null; }
}

const claudeBin = () => process.env.BAJZI_RADAR_CLAUDE || 'claude';
// --tools is the sandbox: with --allowedTools alone the session still had Bash and the
// owner's settings allow rules ran it (smoke check, CLI 2.1.286). --allowedTools keeps the
// five from being refused under dontAsk.
const claudeArgs = () => ['-p', '--model', 'opus', '--permission-mode', 'dontAsk', '--tools', ...RO_TOOLS,
  '--allowedTools', ...RO_TOOLS, '--strict-mcp-config', '--no-session-persistence'];

function realExec(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120e3, windowsHide: true, maxBuffer: 16 << 20 });
  if (r.error) throw r.error;
  return r;
}

function realClaude(prompt, { cwd }) {
  const r = spawnSync(claudeBin(), claudeArgs(), {
    cwd, input: prompt, encoding: 'utf8', timeout: 40 * 60e3, killSignal: 'SIGKILL', maxBuffer: 64 << 20, windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? '\n' + r.error.message : '') };
}

const oneLine = s => String(s || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';

async function run({ state = stateDir(), now = new Date(), claude = realClaude, exec = realExec, home = os.homedir(), projectsDir } = {}) {
  now = +now;
  projectsDir = projectsDir || path.join(home, '.claude', 'projects');
  const reportsDir = path.join(state, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reps = listReports(state);
  const since = reps.length ? reps[0].mtimeMs : now - 14 * DAY;

  const bin = claudeBin();
  const step = (args, fn) => {
    try {
      const r = exec(bin, args);
      if (!r || r.status !== 0) throw new Error('exit ' + (r && r.status) + (r && oneLine(r.stderr) ? ': ' + oneLine(r.stderr) : ''));
      return fn(String(r.stdout || ''));
    } catch (e) { return [`FAILED (${oneLine(e && e.message) || 'error'})`]; }
  };
  const upd = step(['plugin', 'marketplace', 'update'], () => ['ok']);
  const ver = step(['--version'], out => [oneLine(out) || '(empty)']);
  const plugins = step(['plugin', 'list', '--json'], out => JSON.parse(out)
    .map(p => `  - ${p.id}@${p.version}${p.enabled === false ? ' (disabled)' : ''}`));

  const root = bajziRoot(home);
  const mp = path.join(home, '.claude', 'plugins', 'marketplaces');
  const clone = path.join(mp, 'bajzi-plugins');
  const ctx = [
    '## Context (written by radar.js; read these paths with your Read/Glob/Grep tools)',
    `- date: ${ymd(now)}`,
    `- since: ${iso(since)}`,
    `- state dir: ${state}`,
    `- last reports: ${reps.slice(0, 2).map(r => r.path).join(', ') || 'none'}`,
    `- declined list: ${path.join(state, 'declined.md')}`,
    `- owner rule files: ${path.join(home, '.claude', 'CLAUDE.md')}, ${path.join(home, '.claude', 'RTK.md')}`,
    root ? `- installed bajzi root: ${root}; its manifest: ${path.join(root, 'skills', 'setup', 'manifest.json')}`
      : '- installed bajzi root: NOT FOUND in installed_plugins.json',
    `- bajzi marketplace clone: ${clone}; spec: ${path.join(clone, 'docs', 'bajzi-package-spec.md')}; day-run rules: ${path.join(clone, 'bajzi', 'skills', 'mode', 'DAY-RUN-RULES.md')}`,
    `- plugin catalogs: ${path.join(mp, '*', '.claude-plugin', 'marketplace.json')}`,
    `- claude plugin marketplace update: ${upd.join(' ')}`,
    `- claude --version: ${ver.join(' ')}`,
    plugins.length === 1 && plugins[0].startsWith('FAILED') ? `- installed plugins: ${plugins[0]}` : '- installed plugins (claude plugin list --json):',
    ...(plugins.length === 1 && plugins[0].startsWith('FAILED') ? [] : plugins),
  ];
  let dig;
  try { dig = await digest({ projectsDir, since, now }); } catch { dig = '## Usage digest (counts only)\n- unavailable: the digest failed\n'; }
  const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8').trimEnd() + '\n\n' + ctx.join('\n') + '\n\n' + dig;

  let res;
  try { res = await claude(prompt, { cwd: state }); } catch (e) { res = { code: null, stdout: '', stderr: String((e && e.message) || e) }; }
  const out = String((res && res.stdout) || '');
  const lines = out.split(/\r?\n/);
  const first = lines.findIndex(l => l.trim());
  const code = res ? res.code : null;
  if (code === 0 && first >= 0 && lines[first].startsWith('# bajzi radar')) {
    let file = path.join(reportsDir, ymd(now) + '.md');
    for (let i = 2; fs.existsSync(file); i++) file = path.join(reportsDir, `${ymd(now)}-${i}.md`);
    // ponytail: exists-then-rename; two runs in the same second could pick one name. The task is
    // single-instance (MultipleInstances IgnoreNew), so only a manual `now` can race it.
    const tmpf = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmpf, lines.slice(first).join('\n'));
    fs.renameSync(tmpf, file);
    return { ok: true, path: file };
  }
  const errFile = path.join(state, 'last-error.log');
  fs.writeFileSync(errFile, [
    `time: ${new Date().toISOString()}`,
    `exit code: ${code}`,
    `reason: ${code !== 0 ? 'non-zero exit' : 'stdout does not start with "# bajzi radar"'}`,
    '--- stderr (last 40 lines) ---', ...String((res && res.stderr) || '').split(/\r?\n/).slice(-40),
    '--- stdout (first 20 lines) ---', ...lines.slice(0, 20), '',
  ].join('\n'));
  return { ok: false, path: errFile };
}

function notice(state = stateDir()) {
  try {
    const rep = listReports(state)[0];
    const seenM = mtime(path.join(state, '.seen'));
    if (rep && (seenM === null || rep.mtimeMs > seenM)) {
      return JSON.stringify({ systemMessage: `bajzi radar: new report ${rep.path} - run /bajzi:radar to review` });
    }
    const errFile = path.join(state, 'last-error.log');
    const errM = mtime(errFile);
    if (errM !== null && (!rep || errM > rep.mtimeMs) && (seenM === null || errM > seenM)) {
      return JSON.stringify({ systemMessage: `bajzi radar: last run failed - ${errFile}` });
    }
  } catch { /* a SessionStart hook never fails */ }
  return '';
}

function seen(state = stateDir()) {
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, '.seen'), new Date().toISOString() + '\n');
}

const LAUNCHER = `'use strict';
// bajzi radar launcher, written by radar.js install-task. It resolves the CURRENT bajzi install
// from installed_plugins.json at every launch, so a plugin update never breaks the schedule.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
let radar;
try {
  const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  radar = path.join(j.plugins['bajzi@bajzi-plugins'][0].installPath, 'skills', 'radar', 'radar.js');
  if (!fs.existsSync(radar)) throw new Error('missing ' + radar);
} catch (e) {
  fs.writeFileSync(path.join(__dirname, 'last-error.log'), 'launcher: cannot resolve the bajzi install: ' + e.message + '\\n');
  process.exit(1);
}
const r = spawnSync(process.execPath, [radar, 'run'], { stdio: 'inherit', env: Object.assign({}, process.env, { BAJZI_RADAR_HOME: __dirname }) });
process.exit(r.status === null ? 1 : r.status);
`;

// Pure: the PowerShell that registers the task for the current user (no elevation).
function taskCommand({ node, launch }) {
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  return [
    `$a = New-ScheduledTaskAction -Execute ${q(node)} -Argument ${q('"' + launch + '"')}`,
    "$t = New-ScheduledTaskTrigger -Weekly -WeeksInterval 2 -DaysOfWeek Monday -At '10:00'",
    '$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew',
    '$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited',
    'Register-ScheduledTask -TaskName bajzi-radar -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null',
    "'NextRunTime: ' + (Get-ScheduledTaskInfo -TaskName bajzi-radar).NextRunTime",
  ].join('\n');
}

// cron has no "every 2 weeks": the epoch-week parity test skips every other Monday.
const cronLine = ({ node, launch }) => '# bajzi radar, every 2nd Monday 10:00 (add with: crontab -e)\n'
  + `0 10 * * 1 [ $(( $(date +\\%s) / 604800 \\% 2 )) -eq 0 ] && "${node}" "${launch}"`;

function installTask({ platform = process.platform, state = stateDir(), node = process.execPath, exec = realExec } = {}) {
  fs.mkdirSync(state, { recursive: true });
  const launch = path.join(state, 'launch.js');
  fs.writeFileSync(launch, LAUNCHER);
  if (platform !== 'win32') return { code: 0, out: cronLine({ node, launch }) };
  const enc = Buffer.from(taskCommand({ node, launch }), 'utf16le').toString('base64');
  let r;
  try { r = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc]); } catch (e) {
    return { code: 1, out: 'install-task: powershell failed: ' + e.message };
  }
  return r && r.status === 0 ? { code: 0, out: String(r.stdout || '').trim() }
    : { code: 1, out: 'install-task: Register-ScheduledTask failed: ' + String((r && (r.stderr || r.stdout)) || '').trim() };
}

async function main(cmd) {
  const state = stateDir();
  if (cmd === 'digest') {
    const reps = listReports(state);
    const now = Date.now();
    process.stdout.write(await digest({ projectsDir: path.join(os.homedir(), '.claude', 'projects'), since: reps.length ? reps[0].mtimeMs : now - 14 * DAY, now }));
    return 0;
  }
  if (cmd === 'run') {
    const r = await run({ state });
    console.log((r.ok ? 'report: ' : 'radar run failed, see: ') + r.path);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'seen') { seen(state); return 0; }
  if (cmd === 'install-task') {
    const r = installTask({ state });
    console.log(r.out);
    return r.code;
  }
  console.error('usage: node radar.js <digest|run|notice|seen|install-task>');
  return 2;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'notice') {
    try { const s = notice(); if (s) process.stdout.write(s + '\n'); } catch { /* silent */ }
    process.exitCode = 0;
  } else {
    main(cmd).then(c => { process.exitCode = c; }, e => { console.error('radar: ' + ((e && e.message) || e)); process.exitCode = 1; });
  }
}

module.exports = { stateDir, digest, run, notice, seen, installTask, taskCommand, cronLine, claudeArgs, listReports, bajziRoot, LAUNCHER };
