'use strict';
// saver-guard.js: an L2/L3 session on an Anthropic provider may not write code itself; GLM writes.
// Every check() call gets an injected env, home, tmpdir and clock: never process.env (the worker
// shim exports BAJZI_SESSION_LEVEL) and never the real time (the Z.ai peak window relaxes denies).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { check } = require('../saver-guard');

const NOON = new Date('2026-10-06T12:00:00Z');   // outside the 06:00-10:00 UTC peak
const PEAK = new Date('2026-10-06T07:00:00Z');
const GLM_URL = 'https://api.z.ai/api/anthropic';

// Separate dirs: a cwd under the injected tmpdir would make every write "allowed".
function ctx(env = {}, now = NOON) {
  const cwd = tmpDir('bajzi-sgc-');
  const home = tmpDir('bajzi-sgh-');
  const tmp = tmpDir('bajzi-sgt-');
  return { cwd, home, tmp, opts: { env, home, now, tmpdir: tmp } };
}
const call = (c, tool_name, tool_input, extra = {}) =>
  check(Object.assign({ session_id: 's1', hook_event_name: 'PreToolUse', cwd: c.cwd, tool_name, tool_input }, extra), c.opts);
const edit = (c, file, extra) => call(c, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, extra);
const bash = (c, command, tool = 'Bash') => call(c, tool, { command });
const agent = (c, subagent_type, tool = 'Agent') => call(c, tool, subagent_type === undefined ? { prompt: 'x' } : { prompt: 'x', subagent_type });
const isDeny = (d, msg) => assert.ok(d && d.kind === 'deny' && d.rule === 'saver-guard', `${msg}: ${JSON.stringify(d)}`);
const logOf = c => { try { return fs.readFileSync(path.join(c.cwd, 'runtime', 'routing-violations.log'), 'utf8'); } catch { return ''; } };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('gate closed: a level file alone never activates the guard', () => {
  const c = ctx({});
  put(path.join(c.home, '.claude', 'worker-mode'), 'tight\n');
  assert.strictEqual(edit(c, 'src/x.js'), null);
  assert.strictEqual(call(Object.assign({}, c, { opts: Object.assign({}, c.opts, { env: { CC_WORKER_MODE: ' \t' } }) }), 'Edit', { file_path: 'src/x.js' }), null);
});

test('gate: day-run in <home>/.claude/bajzi-mode opens it; an existing <cwd>/runtime/bajzi-mode alone decides', () => {
  const c = ctx({});
  put(path.join(c.home, '.claude', 'worker-mode'), 'glm\n');
  put(path.join(c.home, '.claude', 'bajzi-mode'), ' Day-Run \r\n');
  isDeny(edit(c, 'src/x.js'), 'home day-run');
  put(path.join(c.cwd, 'runtime', 'bajzi-mode'), 'off\n');
  assert.strictEqual(edit(c, 'src/x.js'), null);
  put(path.join(c.cwd, 'runtime', 'bajzi-mode'), 'day-run\n');
  fs.rmSync(path.join(c.home, '.claude', 'bajzi-mode'));
  isDeny(edit(c, 'src/x.js'), 'cwd day-run');
});

test('L0 and L1: null', () => {
  for (const lvl of ['claude', 'light', 'nonsense']) {
    const c = ctx({ CC_WORKER_MODE: lvl });
    assert.strictEqual(edit(c, 'src/x.js'), null, lvl);
    assert.strictEqual(agent(c, 'general-purpose'), null, lvl);
    assert.strictEqual(bash(c, 'sed -i s/a/b/ x.js'), null, lvl);
  }
});

test('L2 and L3 on Anthropic: file-edit tools deny outside runtime/, ~/.claude/ and tmpdir', () => {
  for (const [lvl, n] of [['glm', 2], ['tight', 3]]) {
    for (const env of [{ CC_WORKER_MODE: lvl }, { CC_WORKER_MODE: lvl, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }]) {
      const c = ctx(env);
      const d = edit(c, 'src/x.js');
      isDeny(d, lvl);
      assert.strictEqual(d.reason, `saver-guard: this session is at L${n} but runs on Claude (started with plain claude). Writing code is GLM's job here: run it as glm -p with the brief on stdin (Bash run_in_background), or relaunch the session with worker. Risk slices: bajzi:implementer-risk. Owner override: type ! worker --level 0 in the prompt.`);
      isDeny(call(c, 'Write', { file_path: path.join(c.cwd, 'a.js'), content: 'x' }), 'Write');
      isDeny(call(c, 'MultiEdit', { file_path: 'a.js', edits: [] }), 'MultiEdit');
      isDeny(call(c, 'NotebookEdit', { notebook_path: 'n.ipynb' }), 'NotebookEdit');
      isDeny(edit(c, 'runtime'), 'the runtime dir itself is not under it');
      isDeny(edit(c, '../x/runtime/a.md'), 'another runtime/');
      assert.strictEqual(edit(c, 'runtime/x.md'), null);
      assert.strictEqual(edit(c, path.join(c.cwd, 'runtime', 'sub', 'x.md')), null);
      assert.strictEqual(edit(c, path.join(c.home, '.claude', 'x')), null);
      assert.strictEqual(edit(c, path.join(c.tmp, 'x.js')), null);
      assert.strictEqual(call(c, 'NotebookEdit', { notebook_path: 'runtime/n.ipynb' }), null);
    }
  }
});

test('the risk implementer sub-agent may edit; every other agent_type may not', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const t of ['bajzi:implementer-risk', 'implementer-risk', 'BAJZI:Implementer-Risk']) {
    assert.strictEqual(edit(c, 'src/x.js', { agent_id: 'a1', agent_type: t }), null, t);
  }
  for (const t of ['bajzi:implementer', 'general-purpose', 'implementer-risky', 'bajzi:implementer-risk-x']) {
    isDeny(edit(c, 'src/x.js', { agent_id: 'a1', agent_type: t }), t);
  }
});

test('a GLM provider is never touched', () => {
  const c = ctx({ CC_WORKER_MODE: 'tight', ANTHROPIC_BASE_URL: GLM_URL });
  assert.strictEqual(edit(c, 'src/x.js'), null);
  assert.strictEqual(agent(c, 'general-purpose'), null);
  assert.strictEqual(bash(c, 'worker --level 0'), null);
  assert.strictEqual(bash(c, 'sed -i s/a/b/ x.js'), null);
  const day = ctx({ ANTHROPIC_BASE_URL: GLM_URL });   // gate open via day-run, level forced tight: still GLM
  put(path.join(day.cwd, 'runtime', 'bajzi-mode'), 'day-run\n');
  assert.strictEqual(edit(day, 'src/x.js'), null);
  assert.strictEqual(logOf(c) + logOf(day), '');
});

test('Agent/Task: only the read-only and risk agents pass', () => {
  const c = ctx({ CC_WORKER_MODE: 'tight' });
  for (const tool of ['Agent', 'Task']) {
    for (const t of ['bajzi:implementer', 'bajzi:fixer', 'general-purpose', 'claude', 'statusline-setup', 'my-agent', 'explore', 'PLAN', undefined, '']) {
      isDeny(agent(c, t, tool), `${tool} ${t}`);
    }
    for (const t of ['bajzi:reviewer', 'BAJZI:Reviewer', 'bajzi:implementer-risk', 'Explore', 'Plan', 'claude-code-guide']) {
      assert.strictEqual(agent(c, t, tool), null, `${tool} ${t}`);
    }
  }
});

test('Bash: worker --level/--set is denied, also in the peak window', () => {
  for (const now of [NOON, PEAK]) {
    const c = ctx({ CC_WORKER_MODE: 'glm' }, now);
    for (const cmd of ['worker --level 0', 'worker --set claude', '~/.local/bin/worker.cmd --level=1', 'cd x && worker --global --level 3']) {
      const d = bash(c, cmd);
      isDeny(d, cmd);
      assert.match(d.reason, /only the owner may change the saver level/);
      assert.match(d.reason, /! worker --level <n>/);
      isDeny(bash(c, cmd, 'PowerShell'), `PowerShell ${cmd}`);
    }
    assert.ok(!/cause=peak/.test(logOf(c)));
  }
});

test('Bash: reads, git commit, glm and worker status/usage pass', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['worker --status', 'worker --usage', 'cat ~/.claude/worker-mode', 'ls 2>/dev/null', 'npm test 2>&1 | tail -5',
    'git commit -m x', 'git commit -m "a -> b"', "node -e 'x => x > 1'", 'glm -p < runtime/briefs/b.md', 'git diff --stat',
    'echo hi > runtime/a.txt', 'echo hi >> ./runtime/a.txt', `echo hi > ${c.tmp}/a`, 'echo hi > ~/.claude/x', 'cmd >&2', 'echo x | tee runtime/log.txt',
    'cat x | tee /dev/null', 'grep -rn tee src', 'sed -n 1,5p x.js',
    "glm -p <<'EOF'\nmake count >= 1 hold; it's GLM's job\nEOF", "git commit -F - <<'EOF'\nfix: a > b\nEOF",
    'glm -p <<-EOF\n\tx | tee out.txt\n\tEOF\necho done']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
});

test('Bash: obvious file writes outside the allowed dirs are denied', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['sed -i s/a/b/ x.js', "sed -E -i.bak 's/a/b/' x.js", 'perl -pi -e s/a/b/ x.js', 'echo hi > src/a.txt',
    'echo hi >>a.txt', 'cat <<EOF > src/x.js', 'ls 2> err.txt', 'echo x &> out.txt', 'echo x | tee out.txt', 'echo x | tee -a runtime/ok out.txt',
    'echo hi > "src/a b.js"', "cat <<'EOF' > src/x.js\nx\nEOF", 'glm -p <<EOF\nx\nEOF\necho y > src/a.txt']) {
    isDeny(bash(c, cmd), cmd);
  }
});

test('PowerShell: Set-Content/Add-Content/Out-File/New-Item File outside the allowed dirs are denied', () => {
  const c = ctx({ CC_WORKER_MODE: 'tight' });
  for (const cmd of ['Set-Content x.js 1', 'Add-Content -Value 1 -Path src/x.js', '"x" | Out-File src/a.txt', 'New-Item -ItemType File src/a.js',
    'new-item src/a.js -itemtype file', 'Set-Content -Value 1 x.js', 'echo 1 > x.js']) {
    isDeny(bash(c, cmd, 'PowerShell'), cmd);
  }
  for (const cmd of ['Get-Content x.js', 'Set-Content runtime/x.md 1', 'Add-Content -Path runtime/a.txt -Value 1', '"x" | Out-File -FilePath runtime/a.txt',
    'New-Item -ItemType Directory foo', 'echo 1 > $null', 'echo 1 2>$NULL', 'Out-File ~/.claude/x']) {
    assert.strictEqual(bash(c, cmd, 'PowerShell'), null, cmd);
  }
});

test('every deny appends one cause=blocked line', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  isDeny(edit(c, 'src/x.js'), 'edit');
  isDeny(agent(c, 'general-purpose'), 'agent');
  isDeny(bash(c, 'worker --level 0'), 'worker');
  assert.match(logOf(c), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tlevel=glm\tcause=blocked\ttool=Edit\n\d{4}-[^\n]*\tlevel=glm\tcause=blocked\ttool=Agent\n[^\n]*\tcause=blocked\ttool=Bash\n$/);
  assert.ok(logOf(c).startsWith('2026-10-06T12:00:00Z\t'));
});

test('peak window: write denies become allows, each logged as cause=peak', () => {
  const c = ctx({ CC_WORKER_MODE: 'tight' }, PEAK);
  assert.strictEqual(edit(c, 'src/x.js'), null);
  assert.strictEqual(logOf(c), '2026-10-06T07:00:00Z\tlevel=tight\tcause=peak\ttool=Edit\n');
  assert.strictEqual(agent(c, 'general-purpose'), null);
  assert.strictEqual(bash(c, 'sed -i s/a/b/ x.js'), null);
  assert.strictEqual(bash(c, 'Set-Content x.js 1', 'PowerShell'), null);
  assert.strictEqual(logOf(c).split('\n').length, 5);
  assert.match(logOf(c), /cause=peak\ttool=Agent\n[^\n]*cause=peak\ttool=Bash\n[^\n]*cause=peak\ttool=PowerShell\n$/);
  assert.strictEqual(edit(c, 'runtime/x.md'), null);   // an allowed write is not a peak allow: no line
  assert.strictEqual(logOf(c).split('\n').length, 5);
});

test('fails open: a log write failure, no cwd, bad input, uncovered tools', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  fs.writeFileSync(path.join(c.cwd, 'runtime'), 'a file, so mkdir runtime fails');
  isDeny(edit(c, 'src/x.js'), 'deny survives the log failure');
  assert.strictEqual(check({ tool_name: 'Edit', tool_input: { file_path: '/abs/x.js' } }, c.opts), null);
  for (const bad of [null, 'x', [], {}, { tool_name: 'Edit', cwd: c.cwd }, { tool_name: 'Bash', cwd: c.cwd, tool_input: { command: 1 } }]) {
    assert.strictEqual(check(bad, c.opts), null, JSON.stringify(bad));
  }
  assert.strictEqual(call(c, 'Read', { file_path: 'src/x.js' }), null);
  assert.strictEqual(call(c, 'Skill', { skill: 'x' }), null);
});

test('F1: control files stay denied inside the allowed dirs, also in peak and for the risk agent', () => {
  for (const now of [NOON, PEAK]) {
    const c = ctx({}, now);   // gate open by day-run (no CC_WORKER_MODE), level tight from the machine file
    put(path.join(c.home, '.claude', 'worker-mode'), 'tight\n');
    put(path.join(c.cwd, 'runtime', 'bajzi-mode'), 'day-run\n');
    const h = p => path.join(c.home, '.claude', p);
    for (const f of ['runtime/bajzi-mode', path.join(c.cwd, 'runtime', 'bajzi-mode'), h('bajzi-mode'), h('worker-mode'), h('bajzi/sessions/s1.level'),
      h('cc-router.json'), h('settings.json'), h('settings.local.json'), h('plugins/x/y.js'), path.join(c.cwd, '.claude', 'settings.local.json')]) {
      isDeny(edit(c, f), `Edit ${f}`);
      isDeny(call(c, 'Write', { file_path: f, content: 'x' }, { agent_id: 'a1', agent_type: 'bajzi:implementer-risk' }), `risk Write ${f}`);
    }
    const sd = tmpDir('bajzi-sgs-');
    const c2 = Object.assign({}, c, { opts: Object.assign({}, c.opts, { env: { BAJZI_STATUS_DIR: sd } }) });
    isDeny(edit(c2, path.join(sd, 's2.level')), 'BAJZI_STATUS_DIR level file');
    for (const cmd of ['echo off > runtime/bajzi-mode', 'echo claude > ~/.claude/worker-mode', `echo claude > ${h('bajzi/sessions/s1.level')}`,
      'echo x | tee ~/.claude/settings.json', 'sed -i s/a/b/ ~/.claude/worker-mode']) {
      isDeny(bash(c, cmd), cmd);
    }
    assert.strictEqual(edit(c, 'runtime/x.md'), null);
    assert.strictEqual(edit(c, h('x')), null);
    assert.strictEqual(edit(c, h('bajzi/sessions/s1.json')), null);
    assert.strictEqual(bash(c, 'echo hi > runtime/a.txt'), null);
  }
});

test('F2/F3/F4: worker --level is judged on the command, not on quoted or heredoc text', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['grep -rn "worker --level" docs', "glm -p <<'EOF'\nrun worker --level 0 later\nEOF", "git commit -F - <<'EOF'\nmention worker --level 0\nEOF",
    'git commit -m "worker --level 0"', 'worker --status && echo --level', 'worker --set-model x', 'worker --set-fast-model x', 'worker --set-orchestrator-model x',
    'node bajzi/bin/cc-router.js --status', 'grep -n level bajzi/bin/cc-router.js']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  for (const now of [NOON, PEAK]) {
    const p = ctx({ CC_WORKER_MODE: 'glm' }, now);
    for (const cmd of ['node ~/.claude/plugins/cache/bajzi/1.0/bin/cc-router.js --level 0', 'node bin/cc-router.js --set claude', 'worker "--level" 0',
      'bash -c "worker --level 0"', 'worker --set=claude']) {
      isDeny(bash(p, cmd), cmd);
    }
  }
});

test('F5: the project root is CLAUDE_PROJECT_DIR; runtime/ and the log live there, not under cwd', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  const proj = tmpDir('bajzi-sgp-');
  fs.mkdirSync(path.join(proj, 'src'));
  const sub = { cwd: path.join(proj, 'src'), home: c.home, tmp: c.tmp, opts: { env: { CC_WORKER_MODE: 'glm', CLAUDE_PROJECT_DIR: proj }, home: c.home, now: NOON, tmpdir: c.tmp } };
  assert.strictEqual(edit(sub, path.join(proj, 'runtime', 'x.md')), null);
  assert.strictEqual(bash(sub, `echo hi > ${path.join(proj, 'runtime', 'a.txt')}`), null);
  isDeny(edit(sub, 'x.js'), 'src write');
  isDeny(edit(sub, 'runtime/x.md'), 'src/runtime is not the project runtime');
  assert.ok(!fs.existsSync(path.join(proj, 'src', 'runtime')));
  assert.match(fs.readFileSync(path.join(proj, 'runtime', 'routing-violations.log'), 'utf8'), /cause=blocked/);
});

test('F6: variable and MSYS forms of an allowed dir resolve', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['echo x > /tmp/a', 'echo x > "$HOME/.claude/a"', 'echo x > $HOME/.claude/a', 'echo x > ${HOME}/.claude/a', 'echo x > $TMPDIR/x', 'echo x > ${TMPDIR}/x']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  for (const cmd of ['"x" | Out-File $env:TEMP\\a', 'Set-Content $env:TMP\\a 1', 'Out-File $env:USERPROFILE\\.claude\\a']) {
    assert.strictEqual(bash(c, cmd, 'PowerShell'), null, cmd);
  }
  for (const cmd of ['echo x > /tmpx/a', 'echo x > $HOME/src/a', 'echo x > $UNKNOWN/a']) isDeny(bash(c, cmd), cmd);
  isDeny(bash(c, 'echo x > $HOME/../a'), 'dotdot');
  if (process.platform === 'win32') {
    const d = c.tmp.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, l) => `/${l.toLowerCase()}`);
    assert.strictEqual(bash(c, `echo x > ${d}/a`), null, d);
    isDeny(bash(c, 'echo x > /c/zzz-not-allowed/a'), '/c/ elsewhere');
  }
});

test('F7: sed -i / perl -i are judged by their target', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['sed -i s/a/b/ runtime/x.md', 'perl -pi -e s/a/b/ ~/.claude/x', "sed -E -i.bak 's/a/b/' runtime/x.md", 'sed --in-place -e s/a/b/ runtime/x.md', `sed -i s/a/b/ ${c.tmp}/x`]) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  for (const cmd of ['sed -i s/a/b/ src/x.js', 'perl -pi -e s/a/b/ src/x.js', 'sed -i s/a/b/ runtime/x.md src/x.js', 'sed -i s/a/b/', 'sed -i -e s/a/b/ src/x.js']) {
    isDeny(bash(c, cmd), cmd);
  }
});

test('F8: perl -M/-m flags are not in-place edits', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ["perl -Mstrict -ne 'print' x.txt", 'perl -MList::Util=sum -e 1', 'perl -Mwarnings -e 1', 'perl -ne print x.txt']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  isDeny(bash(c, 'perl -0777pi -e s/a/b/ x.js'), '-0777pi');
  isDeny(bash(c, 'perl -i.bak -pe s/a/b/ x.js'), '-i.bak');
});

test('F9: a redirect without a space before > is seen', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['echo hi>src/a.js', 'echo "x">src/a.js', 'cat <<EOF>src/x.js', 'echo hi>>src/a.js', 'echo hi 2>src/e']) isDeny(bash(c, cmd), cmd);
  for (const cmd of ['echo hi>runtime/a.js', 'echo "a -> b"', 'node -e "x => x>1"', 'echo x>/dev/null', 'ls 2>&1']) assert.strictEqual(bash(c, cmd), null, cmd);
});

test('F10: a quoted mention of worker --level next to a shell word is not a level change', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['git commit -m "docs: worker --level" && bash tests/x.sh', 'glm -p "run bash x.sh; mention worker --level"']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  isDeny(bash(c, 'bash -c "worker --level 0"'), 'wrapped');
});

test('F11: an unterminated <<WORD swallows nothing', () => {
  for (const now of [NOON, PEAK]) {
    const c = ctx({ CC_WORKER_MODE: 'glm' }, now);
    isDeny(bash(c, '# <<A\nworker --level 0'), 'comment heredoc');
    isDeny(bash(c, 'echo "<<A"\necho claude > ~/.claude/worker-mode'), 'quoted heredoc');
  }
});

test('F12: level/set without dashes and backslash continuations are level changes', () => {
  for (const now of [NOON, PEAK]) {
    const c = ctx({ CC_WORKER_MODE: 'glm' }, now);
    for (const cmd of ['worker level 0', 'worker set claude', 'node bin/cc-router.js level 0', 'worker \\\n--level 0', 'worker \\\r\nlevel 0']) isDeny(bash(c, cmd), cmd);
    assert.strictEqual(bash(c, 'grep -n level bajzi/bin/cc-router.js'), null);
  }
});

test('F13: the day-run gate reads <project>/runtime/bajzi-mode, never the hook cwd', () => {
  const c = ctx({});
  const proj = tmpDir('bajzi-sgp-');
  put(path.join(proj, 'runtime', 'bajzi-mode'), 'day-run\n');
  put(path.join(c.home, '.claude', 'worker-mode'), 'tight\n');
  put(path.join(proj, 'src', 'x'), '');
  put(path.join(proj, 'runtime', 'x', 'x'), '');
  const at = cwd => ({ cwd, home: c.home, tmp: c.tmp, opts: { env: { CLAUDE_PROJECT_DIR: proj }, home: c.home, now: NOON, tmpdir: c.tmp } });
  isDeny(edit(at(path.join(proj, 'src')), 'x.js'), 'cwd = src');
  put(path.join(proj, 'runtime', 'x', 'runtime', 'bajzi-mode'), 'off\n');
  isDeny(edit(at(path.join(proj, 'runtime', 'x')), path.join(proj, 'src', 'x.js')), 'cwd = runtime/x');
});

test('F14/F15: a control file as a write target is denied, also in peak; reading one passes', () => {
  const isProtected = (d, msg) => { isDeny(d, msg); assert.match(d.reason, /this file controls the saver guard or the saver level/, msg); };
  for (const now of [NOON, PEAK]) {
    const c = ctx({}, now);
    put(path.join(c.home, '.claude', 'worker-mode'), 'tight\n');
    put(path.join(c.cwd, 'runtime', 'bajzi-mode'), 'day-run\n');
    for (const cmd of ['echo claude > ~/.claude/worker-mode', 'sed -i s/day-run/off/ runtime/bajzi-mode']) isProtected(bash(c, cmd), cmd);
    for (const cmd of ['Set-Content ~/.claude/bajzi-mode off', 'New-Item ~/.claude/worker-mode -Value claude -Force']) isProtected(bash(c, cmd, 'PowerShell'), cmd);
    isProtected(edit(c, '~/.claude/bajzi/sessions/s1.level'), 'Edit s1.level');
    for (const cmd of ['cat ~/.claude/worker-mode', 'git log -p -- runtime/bajzi-mode | head -5', 'grep day runtime/bajzi-mode && ls ~/.claude/bajzi/sessions/s1.level']) {
      assert.strictEqual(bash(c, cmd), null, cmd);
    }
  }
  const c = ctx({ CC_WORKER_MODE: 'tight' });
  for (const cmd of ['New-Item src/a.js -Value x', 'New-Item -Type File src/a.js', 'New-Item -ItemType File src/a.js']) isDeny(bash(c, cmd, 'PowerShell'), cmd);
  for (const cmd of ['New-Item -ItemType Directory foo', 'New-Item -Type Directory foo']) assert.strictEqual(bash(c, cmd, 'PowerShell'), null, cmd);
});

test('control-file look-alikes are ordinary work', () => {
  const c = ctx({ CC_WORKER_MODE: 'glm' });
  for (const cmd of ['git add bajzi/skills/night-run/templates/settings.local.json.tmpl', 'git commit -m "parse settings.json"',
    'echo x > runtime/app-settings.json', 'git add docs/worker-mode.md', 'git add hooks/bajzi-mode.sh', 'rm src/x.level.js']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
});

test('plugin scripts, mode/level file reads and a message or brief naming a control file pass', () => {
  const c = ctx({ CC_WORKER_MODE: 'tight' });
  const plug = `${c.home}/.claude/plugins/cache/m/bajzi/1.0`;
  for (const cmd of [`node "${plug}/lib/findings-cli.js" list`, `bash "${plug}/skills/night-run/run.sh" --help`,
    "head -1 runtime/bajzi-mode | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'", 'cat ~/.claude/worker-mode 2>/dev/null',
    'grep -i day runtime/bajzi-mode', 'git commit -m "worker-mode: read from project root"', "glm -p <<'EOF'\nfix the bajzi-mode reader\nEOF"]) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  assert.strictEqual(logOf(c), '');
});

test('windows tier accepted limits: delete/move/copy of a control file is not seen (Linux sandbox closes it)', () => {
  const c = ctx({ CC_WORKER_MODE: 'tight' });
  for (const cmd of ['rm runtime/bajzi-mode', 'rm ~/.claude/worker-mode', 'rm ~/.claude/cc-router.json', 'rm ~/.claude/bajzi/sessions/s1.level',
    'rm .claude/settings.local.json', 'mv runtime/x ~/.claude/worker-mode', 'cp a ~/.claude/settings.json', 'echo x | cp a ~/.claude/settings.json']) {
    assert.strictEqual(bash(c, cmd), null, cmd);
  }
  for (const cmd of ['Remove-Item ~/.claude/bajzi-mode', 'Move-Item a ~/.claude/cc-router.json']) assert.strictEqual(bash(c, cmd, 'PowerShell'), null, cmd);
  assert.strictEqual(logOf(c), '');
});
