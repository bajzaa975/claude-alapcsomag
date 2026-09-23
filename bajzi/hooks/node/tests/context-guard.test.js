'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NODE_DIR, tmpDir, runScript, p95 } = require('./helpers');
const { writeBridge } = require('../lib/bridge');
const { decide, slugify } = require('../context-guard');

const SCRIPT = path.join(NODE_DIR, 'context-guard.js');
const pre = (tool_name, tool_input, extra = {}) => Object.assign({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name, tool_input }, extra);
const post = tool_name => ({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name, tool_input: {} });

function at(pct, input, ageSec = 0) {
  const dir = tmpDir('bajzi-cg-');
  const now = Date.now();
  writeBridge('s1', pct, now - ageSec * 1000, dir);
  return decide(input, { nowMs: now, dir });
}

function allowedBy(rule, d, label) {
  assert.deepStrictEqual(d, { kind: 'allow', rule }, label);
}

function denied(d, label) {
  assert.strictEqual(d.kind, 'deny', label);
  assert.strictEqual(d.rule, 'ctx-block-50', label);
}

test('RF4: handoff writes stay allowed at 55%', () => {
  for (const [tool, p] of [
    ['Write', 'runtime/handoff/x.md'],
    ['Write', 'D:\\repo\\runtime\\handoff\\x.md'],
    ['Write', '/home/u/repo/runtime/handoff/feat-y.md'],
    ['Edit', 'runtime/HANDOFF.md'],
    ['Edit', '/home/u/repo/runtime/HANDOFF.md'],
    ['MultiEdit', 'D:\\repo\\runtime\\HANDOFF.md'],
    ['Read', 'runtime/handoff/x.md'],
    ['Read', 'D:/repo/runtime/HANDOFF.md'],
  ]) {
    allowedBy('ctx-allow-handoff-file', at(55, pre(tool, { file_path: p })), `${tool} ${p}`);
  }
});

test('RF4: git status allowed, git status && rm -rf x denied', () => {
  for (const [tool, cmd] of [
    ['Bash', 'git status'], ['Bash', 'git diff --stat'], ['Bash', '/usr/bin/git log --oneline -5'],
    ['PowerShell', 'git log -5'], ['Bash', 'git -C "D:\\repo" status'],
  ]) {
    allowedBy('ctx-allow-git-read', at(55, pre(tool, { command: cmd })), cmd);
  }
  for (const cmd of ['git status && rm -rf x', 'git status; rm -rf x', 'git log | cat', 'git diff --output=x.patch',
    'git status $(rm -rf x)', 'git stash', 'git commit -m x', 'rm -rf x']) {
    denied(at(55, pre('Bash', { command: cmd })), cmd);
  }
});

test('I1a: the Skill tool invoking bajzi:handoff is allowed at 55%, other skills are not', () => {
  for (const ti of [{ skill: 'bajzi:handoff' }, { skill: 'handoff' }, { name: 'bajzi:handoff' }, { skill: 'bajzi:handoff', args: 'x' },
    { skill: '/bajzi:handoff' }]) {
    allowedBy('ctx-allow-handoff-skill', at(55, pre('Skill', ti)), JSON.stringify(ti));
  }
  allowedBy('ctx-allow-handoff-skill', at(55, pre('SlashCommand', { command: '/bajzi:handoff note' })), 'SlashCommand');
  for (const ti of [{ skill: 'bajzi:mode' }, { skill: 'superpowers:brainstorming' }, { skill: 'bajzi:handoffx' }, { skill: 'other:handoff' }, {}]) {
    denied(at(55, pre('Skill', ti)), JSON.stringify(ti));
  }
});

test('I1b: the handoff skill snippets are allowed as single commands', () => {
  for (const [rule, cmd] of [
    ['ctx-allow-handoff-mkdir', 'mkdir -p runtime/handoff'],
    ['ctx-allow-handoff-mkdir', 'mkdir -p runtime/handoff/'],
    ['ctx-allow-git-read', 'git symbolic-ref --quiet --short HEAD'],
    ['ctx-allow-git-read', 'git symbolic-ref --quiet --short HEAD 2>/dev/null'],
    ['ctx-allow-git-read', 'git rev-parse --show-toplevel'],
    ['ctx-allow-git-read', 'git check-ignore -q runtime/'],
    ['ctx-allow-git-read', 'git status --porcelain 2>/dev/null'],
    ['ctx-allow-handoff-mv', 'git mv runtime/HANDOFF.md runtime/handoff/feat-x.md'],
    ['ctx-allow-handoff-mv', 'mv runtime/HANDOFF.md runtime/handoff/feat-x.md'],
    ['ctx-allow-handoff-mv', 'git mv "runtime/HANDOFF.md" "runtime/handoff/feat-x.md"'],
  ]) {
    allowedBy(rule, at(55, pre('Bash', { command: cmd })), cmd);
  }
  // PowerShell keeps backslashes as path separators: the same snippets stay allowed there.
  for (const [rule, cmd] of [
    ['ctx-allow-handoff-mkdir', 'mkdir runtime\\handoff'],
    ['ctx-allow-handoff-mv', 'git mv runtime\\HANDOFF.md runtime\\handoff\\feat-x.md'],
    ['ctx-allow-handoff-mv', 'mv runtime/HANDOFF.md runtime/handoff/feat-x.md'],
  ]) {
    allowedBy(rule, at(55, pre('PowerShell', { command: cmd })), cmd);
  }
});

test('I1b: look-alikes and chains of the handoff snippets are denied', () => {
  for (const cmd of [
    'mkdir -p src', 'mkdir -p runtime/handoff/../../src', 'mkdir -p runtime/handoff && rm -rf x', 'mkdir -p runtime/handoff runtime/x',
    'git symbolic-ref HEAD refs/heads/evil', 'git symbolic-ref --short HEAD; rm -rf x',
    'git mv src/app.py runtime/handoff/x.md', 'git mv runtime/HANDOFF.md src/x.md', 'git mv runtime/HANDOFF.md runtime/handoff/../../x.md',
    'git mv runtime/HANDOFF.md runtime/handoff/', 'git mv -f runtime/HANDOFF.md runtime/handoff/x.md', 'mv src/app.py runtime/handoff/x.md',
    'git -c core.fsmonitor=evil status', 'git -ccore.fsmonitor=evil status', 'git --exec-path=/tmp/evil status','git status `rm -rf x`', 'git status 2>/dev/null && rm -rf x', 'git status > out.txt',
    'git rev-parse HEAD | xargs rm', 'git diff --ext-diff',
    "b=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || printf '')",
  ]) {
    denied(at(55, pre('Bash', { command: cmd })), cmd);
  }
});

function refusedBy(refused, d, label) {
  denied(d, label);
  assert.strictEqual(d.refused, refused, label);
}

test('I-1: shell escapes, quotes, braces and globs never reach the mv / git mv / mkdir allowances', () => {
  // The shell turns each of these into '..' (or a glob match) that norm() and the '..' check never see:
  // they would overwrite src/app.py or move it away. Only plain path characters are accepted.
  for (const [tool, cmd] of [
    ['Bash', 'mv runtime/HANDOFF.md runtime/handoff/.\\./.\\./src/app.py'],
    ['Bash', 'mv runtime/handoff/.\\./.\\./src/app.py runtime/handoff/x.md'],
    ['Bash', 'git mv runtime/HANDOFF.md runtime/handoff/.\\./.\\./src/app.py'],
    ['Bash', 'git mv runtime/handoff/.\\./.\\./src/app.py runtime/handoff/x.md'],
    ['Bash', 'mkdir -p runtime\\handoff'],
    ['Bash', "mv runtime/HANDOFF.md runtime/handoff/'..'/'..'/src/app.py"],
    ['Bash', 'mv runtime/HANDOFF.md runtime/handoff/".."/".."/src/app.py'],
    ['Bash', "mv runtime/HANDOFF.md runtime/handoff/.''./.''./src/app.py"],
    ['Bash', "git mv runtime/HANDOFF.md runtime/handoff/'..'/'..'/src/app.py"],
    ['Bash', "mv runtime/handoff/'..'/'..'/src/app.py runtime/handoff/x.md"],
    ['Bash', 'mv runtime/handoff/{y,.}./{y,.}./src/app.py runtime/handoff/{y,.}./{y,.}./other'],
    ['Bash', 'mv runtime/HANDOFF.md runtime/handoff/.?/.?/src/app.py'],
    ['Bash', 'mv runtime/HANDOFF.md runtime/handoff/.[.]/.[.]/src/app.py'],
    ['Bash', "mkdir -p 'runtime'/handoff"],
    ['PowerShell', "mv runtime/HANDOFF.md runtime/handoff/'..'/'..'/src/app2.py"],
    ['Bash', 'mv runtime/HANDOFF.md ~/runtime/handoff/x.md'],
    ['Bash', 'mkdir -p ~/runtime/handoff'],
    ['Bash', 'mv runtime/HANDOFF.md C:/other/runtime/handoff/x.md'],
    ['PowerShell', 'mv runtime\\HANDOFF.md C:\\other\\runtime\\handoff\\x.md'],
  ]) {
    refusedBy('path-chars', at(55, pre(tool, { command: cmd })), `${tool} ${cmd}`);
  }
  // Repo-relative only: absolute paths and git -C point at SOME runtime/handoff, not this repo's.
  for (const [tool, cmd] of [
    ['Bash', 'mv runtime/HANDOFF.md /d/other/runtime/handoff/x.md'],
    ['Bash', 'mv /d/other/runtime/HANDOFF.md runtime/handoff/x.md'],
    ['Bash', 'git mv /d/other/runtime/HANDOFF.md runtime/handoff/x.md'],
    ['Bash', 'mkdir -p /d/other/runtime/handoff'],
    ['Bash', 'git -C .. mv runtime/HANDOFF.md runtime/handoff/x.md'],
    ['PowerShell', 'git -C ../other mv runtime/HANDOFF.md runtime/handoff/x.md'],
  ]) {
    refusedBy('path-scope', at(55, pre(tool, { command: cmd })), `${tool} ${cmd}`);
  }
  // '.' and empty segments inside runtime/handoff/ are refused on their own too (any shell).
  for (const tool of ['Bash', 'PowerShell']) {
    for (const cmd of ['mv runtime/HANDOFF.md runtime/handoff/./x.md', 'git mv runtime/HANDOFF.md runtime/handoff//x.md',
      'mv runtime/handoff/./x.md runtime/handoff/y.md']) {
      refusedBy('not-allowlisted', at(55, pre(tool, { command: cmd })), `${tool} ${cmd}`);
    }
  }
});

test('M-1: newline, CRLF and spaced ; chains are refused by the shell-metacharacter check itself', () => {
  for (const cmd of ['git status\nrm -rf x', 'git status\r\nrm -rf x', 'git status ; rm -rf x', 'git status && rm -rf x']) {
    refusedBy('shell-meta', at(55, pre('Bash', { command: cmd })), JSON.stringify(cmd));
  }
  refusedBy('not-allowlisted', at(55, pre('Bash', { command: 'git stash' })), 'git stash');
});

test('M-9: the mkdir allowance is case-insensitive like the other handoff paths', () => {
  allowedBy('ctx-allow-handoff-mkdir', at(55, pre('Bash', { command: 'mkdir -p Runtime/Handoff' })), 'mkdir Runtime/Handoff');
});

test('I1c: the deny reason names runtime/handoff/<slug>.md for the current branch', () => {
  const repo = tmpDir('bajzi-cgr-');
  const g = (...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-C', repo, ...a], { stdio: 'ignore' });
  g('init');
  g('checkout', '-b', 'Feat/Ctx--Guard_X.y');
  const d = at(55, pre('Agent', {}, { cwd: repo }));
  denied(d, 'repo');
  assert.match(d.reason, /runtime\/handoff\/feat-ctx-guard_x\.y\.md/);
  fs.mkdirSync(path.join(repo, 'sub', 'dir'), { recursive: true });              // found from a subdirectory
  assert.match(at(55, pre('Agent', {}, { cwd: path.join(repo, 'sub', 'dir') })).reason, /runtime\/handoff\/feat-ctx-guard_x\.y\.md/);
  const none = at(55, pre('Agent', {}, { cwd: tmpDir('bajzi-cgn-') }));          // not a repo
  assert.match(none.reason, /runtime\/handoff\/default\.md/);
  const wt = tmpDir('bajzi-cgw-');                                                // worktree: .git is a gitdir: file
  const wtGit = tmpDir('bajzi-cgwg-');
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/wt/Branch\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.match(at(55, pre('Agent', {}, { cwd: wt })).reason, /runtime\/handoff\/wt-branch\.md/);
  fs.writeFileSync(path.join(wtGit, 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');  // detached
  assert.match(at(55, pre('Agent', {}, { cwd: wt })).reason, /runtime\/handoff\/default\.md/);
});

test('I1c: slugify matches the handoff skill derivation', () => {
  for (const [b, s] of [
    ['', 'default'], [null, 'default'], ['main', 'main'], ['Feat/X', 'feat-x'], ['--a//b--', 'a-b'], ['---', 'default'],
    ['a'.repeat(59) + '/b', 'a'.repeat(59)], ['x'.repeat(80), 'x'.repeat(60)], ['\u00c9t\u00e9', 't'],
  ]) {
    assert.strictEqual(slugify(b), s, String(b));
  }
});

test('handoff path traversal and look-alikes are denied at 55%', () => {
  for (const p of ['runtime/handoff/../../src/app.py', 'runtime/handoffs/x.md', 'src/runtime-handoff.md', '', 'runtime/handoff/']) {
    assert.strictEqual(at(55, pre('Write', { file_path: p })).rule, 'ctx-block-50', p);
  }
});

test('every other tool is denied at 55% (Agent and Task included)', () => {
  for (const t of ['Write', 'Edit', 'Read', 'Grep', 'Glob', 'Agent', 'Task', 'WebFetch', 'mcp__token-savior__find_symbol']) {
    const d = at(55, pre(t, { file_path: 'src/app.py', pattern: 'x', prompt: 'x' }));
    denied(d, t);
    assert.match(d.reason, /55%/);
    assert.match(d.reason, /\/bajzi:handoff/);
    assert.match(d.reason, /\/clear/);
  }
});

test('49% blocks nothing; exactly 50% blocks', () => {
  assert.deepStrictEqual(at(49, pre('Agent', {})), { kind: 'allow' });
  assert.strictEqual(at(50, pre('Agent', {})).kind, 'deny');
});

test('unknown context = allow: no bridge, stale (61 s), corrupt, unsafe id', () => {
  const dir = tmpDir('bajzi-cg-');
  assert.deepStrictEqual(decide(pre('Agent', {}), { nowMs: Date.now(), dir }), { kind: 'allow' });
  assert.deepStrictEqual(at(90, pre('Agent', {}), 61), { kind: 'allow' });
  fs.writeFileSync(path.join(dir, 'bajzi-ctx-s1.json'), 'garbage');
  assert.deepStrictEqual(decide(pre('Agent', {}), { nowMs: Date.now(), dir }), { kind: 'allow' });
  assert.deepStrictEqual(decide(Object.assign(pre('Agent', {}), { session_id: '../s1' }), { nowMs: Date.now(), dir }), { kind: 'allow' });
});

test('PostToolUse at 45% warns on call 1 and call 6 (once per 5 calls)', () => {
  const dir = tmpDir('bajzi-cg-');
  const now = Date.now();
  writeBridge('s1', 45, now, dir);
  const kinds = [];
  for (let i = 0; i < 7; i++) kinds.push(decide(post('Read'), { nowMs: now, dir }).kind);
  assert.deepStrictEqual(kinds, ['context', 'allow', 'allow', 'allow', 'allow', 'context', 'allow']);
  const first = (() => { fs.rmSync(path.join(dir, 'bajzi-ctx-s1-warned.json')); return decide(post('Read'), { nowMs: now, dir }); })();
  assert.match(first.text, /^\[bajzi:ctx-warn-40\] Context is at 45%/);
  assert.match(first.text, /no new scope/);
});

test('PostToolUse below 40% never warns and writes no state', () => {
  const dir = tmpDir('bajzi-cg-');
  writeBridge('s1', 39, Date.now(), dir);
  assert.deepStrictEqual(decide(post('Read'), { nowMs: Date.now(), dir }), { kind: 'allow' });
  assert.ok(!fs.existsSync(path.join(dir, 'bajzi-ctx-s1-warned.json')));
});

test('unknown hook_event_name = allow', () => {
  assert.deepStrictEqual(at(90, { session_id: 's1', hook_event_name: 'Stop' }), { kind: 'allow' });
});

function spawnGuard(stdin, pct) {
  const tmp = tmpDir('bajzi-cgt-');
  if (pct !== undefined) writeBridge('s1', pct, Date.now(), tmp);
  return runScript(SCRIPT, stdin, { TMPDIR: tmp });
}

test('RF2: context guard survives bad stdin', () => {
  for (const stdin of ['', 'not json', '[]', '{"hook_event_name":"PreToolUse","tool_name":"Agent"}',
    '{"session_id":"s1","tool_name":"Agent"}']) {
    const r = spawnGuard(stdin, 90);
    assert.strictEqual(r.code, 0, stdin);
    assert.strictEqual(r.stdout, '', stdin);
    assert.strictEqual(r.stderr, '', stdin);
  }
  const bom = spawnGuard('\ufeff' + JSON.stringify(pre('Agent', {})), 90);
  assert.strictEqual(bom.code, 0);
  assert.match(JSON.parse(bom.stdout).hookSpecificOutput.permissionDecisionReason, /^\[bajzi:ctx-block-50\]/);
});

test('end to end: deny envelope, exempt = no output, warn envelope', () => {
  const d = JSON.parse(spawnGuard(JSON.stringify(pre('Agent', { prompt: 'x' })), 60).stdout);
  assert.strictEqual(d.hookSpecificOutput.permissionDecision, 'deny');
  const ok = spawnGuard(JSON.stringify(pre('Skill', { skill: 'bajzi:handoff' })), 60);
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(ok.stdout, '');
  const w = JSON.parse(spawnGuard(JSON.stringify(post('Read')), 42).stdout);
  assert.strictEqual(w.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(w.hookSpecificOutput.additionalContext, /^\[bajzi:ctx-warn-40\]/);
});

test('hooks.json wires the guard on PreToolUse and PostToolUse for every tool', () => {
  const h = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '..', 'hooks.json'), 'utf8')).hooks;
  const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/node/context-guard.js"';
  for (const ev of ['PreToolUse', 'PostToolUse']) {
    const e = h[ev].find(x => x.hooks.some(k => k.command === cmd));
    assert.ok(e, ev);
    assert.strictEqual(e.matcher, '.*');
    assert.strictEqual(e.hooks[0].timeout, 5);
  }
  assert.strictEqual(h.PostToolUse[0].matcher, 'Agent|Task');   // mode.sh case 12s pins this
});

// Best of 3 batches: `node --test` runs the test FILES in parallel, and a batch that overlaps the
// status line's own p95 test measures CPU contention, not the guard.
test('p95 of 20 runs < 100 ms (exempt path and deny path), best of 3 batches', () => {
  const tmp = tmpDir('bajzi-cgt-');
  for (const input of [pre('Write', { file_path: 'runtime/handoff/x.md' }), pre('Agent', { prompt: 'x' })]) {
    const stdin = JSON.stringify(input);
    const batches = [];
    for (let b = 0; b < 3 && !(batches.length && Math.min(...batches) < 100); b++) {
      writeBridge('s1', 55, Date.now(), tmp);
      const ms = [];
      for (let i = 0; i < 20; i++) ms.push(runScript(SCRIPT, stdin, { TMPDIR: tmp }).ms);
      batches.push(p95(ms));
    }
    assert.ok(Math.min(...batches) < 100, `${input.tool_name} p95 per batch ${batches.map(x => x.toFixed(1)).join(' / ')} ms`);
  }
});
