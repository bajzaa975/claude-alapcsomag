'use strict';
// critic-gate: the superpowers execution skills in an M/L repo need a ready critic file for the plan.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_DIR, tmpDir, runScript } = require('./helpers');
const G = require('../critic-gate');

const SDD = 'superpowers:subagent-driven-development';
function repo(size, ready) {
  const d = tmpDir('bajzi-cg-');
  if (size) { fs.mkdirSync(path.join(d, '.claude')); fs.writeFileSync(path.join(d, '.claude', 'project-profile.json'), JSON.stringify({ size })); }
  if (ready) {
    fs.mkdirSync(path.join(d, 'runtime', 'critic'), { recursive: true });
    fs.writeFileSync(path.join(d, 'runtime', 'critic', 'pl.md'), '# Critic · pl\n\n## Triage\nskipped: hotfix\n');
  }
  return d;
}
const inp = (cwd, skill, args) => ({ tool_name: 'Skill', cwd, tool_input: { skill, args } });

test('critic-gate: M repo, execution skill, no plan path -> deny', () => {
  const r = G.check(inp(repo('M'), SDD, 'go ahead'));
  assert.strictEqual(r.kind, 'deny');
  assert.strictEqual(r.rule, 'critic-gate');
  assert.strictEqual(G.check(inp(repo('L'), 'superpowers:executing-plans', undefined)).kind, 'deny');
});
test('critic-gate: plan path, critic not ready -> deny naming /bajzi:critic; ready -> null', () => {
  for (const p of ['docs/superpowers/plans/pl.md', 'runtime/plans/pl.md']) {
    const r = G.check(inp(repo('M'), SDD, `execute ${p} now`));
    assert.strictEqual(r.kind, 'deny');
    assert.match(r.reason, /\/bajzi:critic pl\b/);
    assert.strictEqual(G.check(inp(repo('M', true), SDD, p)), null);
  }
});
test('critic-gate: the project is CLAUDE_PROJECT_DIR, not a cd\'d-into subfolder', () => {
  const d = repo('M');
  const sub = path.join(d, 'src');
  fs.mkdirSync(sub);
  const old = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    assert.strictEqual(G.check(inp(sub, SDD, 'go')).kind, 'deny');
    process.env.CLAUDE_PROJECT_DIR = repo('S');
    assert.strictEqual(G.check(inp(sub, SDD, 'go')), null);
  } finally { if (old === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = old; }
});
test('critic-gate: S repo, no profile, other skills and tools -> null', () => {
  assert.strictEqual(G.check(inp(repo('S'), SDD, 'x')), null);
  assert.strictEqual(G.check(inp(repo(), SDD, 'x')), null);
  assert.strictEqual(G.check(inp(repo('M'), 'superpowers:brainstorming', 'x')), null);
  assert.strictEqual(G.check({ tool_name: 'Bash', cwd: repo('M'), tool_input: { command: 'ls' } }), null);
  assert.strictEqual(G.check(null), null);
});
test('pre-tool: denies via the combined entry; a throw in critic-gate is logged and allowed', () => {
  const d = repo('M');
  const input = JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Skill', cwd: d, tool_input: { skill: SDD, args: '' } });
  const r = runScript(path.join(NODE_DIR, 'pre-tool.js'), input);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /\[bajzi:critic-gate\]/);
  // broken copy
  const dir = tmpDir('bajzi-cgb-');
  fs.mkdirSync(path.join(dir, 'lib'));
  for (const sub of ['', 'lib']) for (const f of fs.readdirSync(path.join(NODE_DIR, sub))) if (f.endsWith('.js')) fs.copyFileSync(path.join(NODE_DIR, sub, f), path.join(dir, sub, f));
  fs.writeFileSync(path.join(dir, 'critic-gate.js'), "throw new Error('broken critic-gate');\n");
  const b = runScript(path.join(dir, 'pre-tool.js'), input);
  assert.strictEqual(b.code, 0);
  assert.strictEqual(b.stdout, '');
  assert.match(fs.readFileSync(path.join(b.home, '.claude', 'bajzi', 'hook-errors.log'), 'utf8'), /critic-gate/);
});
