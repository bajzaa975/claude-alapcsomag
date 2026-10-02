'use strict';
// writer-guard.js: only the session started in the bajzi repo's main checkout may edit bajzi files.
// Fake repos in tmp dirs: a main checkout has a real `.git` dir, a linked worktree a `.git` file.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_DIR, tmpDir, runScript } = require('./helpers');
const { check, notice } = require('../writer-guard');

const SCRIPT = path.join(NODE_DIR, 'writer-guard.js');
const HOME = tmpDir('bajzi-wgh-');
const opts = { home: HOME };

function tree(root, name = 'bajzi-plugins') {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bajzi', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name, plugins: [] }));
  return root;
}
function mainRepo(name) {
  const m = tree(path.join(tmpDir('bajzi-wgm-'), 'bajzi-plugins-dev'), name);
  fs.mkdirSync(path.join(m, '.git'));
  return m;
}
function worktree(main, n = 'wt1') {
  const w = tree(path.join(tmpDir('bajzi-wgw-'), n));
  const gd = path.join(main, '.git', 'worktrees', n);
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(w, '.git'), `gitdir: ${gd.replace(/\\/g, '/')}\r\n`);
  return w;
}
const edit = (cwd, file, tool = 'Edit') => ({
  hook_event_name: 'PreToolUse', tool_name: tool, cwd,
  tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file, content: 'x' },
});
const isDeny = d => assert.ok(d && d.kind === 'deny' && d.rule === 'bajzi-writer', JSON.stringify(d));

test('the owner edits a file in its own tree: allow, every covered tool', () => {
  const m = mainRepo();
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.strictEqual(check(edit(m, path.join(m, 'bajzi', 'hooks', 'x.js'), t), opts), null, t);
  }
  assert.strictEqual(check(edit(path.join(m, 'bajzi'), path.join(m, 'README.md')), opts), null);   // cwd a subdir
});

test('the owner edits its own linked worktree: allow', () => {
  const m = mainRepo();
  const w = worktree(m);
  assert.strictEqual(check(edit(m, path.join(w, 'bajzi', 'x.js')), opts), null);
});

test('a foreign session edits a repo file: deny, the reason names main(R) and the inbox', () => {
  const m = mainRepo();
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const d = check(edit(tmpDir('bajzi-wgf-'), path.join(m, 'bajzi', 'hooks', 'x.js'), t), opts);
    isDeny(d);
    assert.ok(d.reason.startsWith(`bajzi plugin changes are made only by a session started in ${m} (the bajzi repo main checkout). Send the request with SendMessage to that session, or write it to ${path.join(m, 'runtime', 'requests')}`), d.reason);
    assert.match(d.reason, /<YYYY-MM-DD>-<topic>\.md\.$/);
  }
  // A file in the foreign session's linked worktree names the MAIN checkout, not the worktree.
  const w = worktree(m);
  const d = check(edit(tmpDir('bajzi-wgf-'), path.join(w, 'bajzi', 'x.js')), opts);
  isDeny(d);
  assert.ok(d.reason.includes(`started in ${m} `), d.reason);
});

test('a session whose cwd is a linked worktree edits that worktree: deny', () => {
  const m = mainRepo();
  const w = worktree(m);
  isDeny(check(edit(w, path.join(w, 'bajzi', 'x.js')), opts));
  isDeny(check(edit(w, path.join(w, 'runtime', 'requests', 'x.md')), opts));   // the inbox is main(R)'s only
  isDeny(check(edit(w, path.join(m, 'bajzi', 'x.js')), opts));
});

test('a bajzi tree that is not a main checkout (no .git, a non-worktree .git file) has no owner: deny', () => {
  const copy = tree(path.join(tmpDir('bajzi-wgc-'), 'bajzi-copy'));
  const d = check(edit(copy, path.join(copy, 'bajzi', 'x.js')), opts);
  isDeny(d);
  assert.ok(d.reason.includes(`started in ${copy} `), d.reason);
  const sub = tree(path.join(tmpDir('bajzi-wgc-'), 'bajzi-sub'));
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/bajzi\n');
  isDeny(check(edit(sub, path.join(sub, 'bajzi', 'x.js')), opts));
});

test('a session in another bajzi main checkout is not the owner of this one: deny', () => {
  const m = mainRepo();
  const other = mainRepo();
  isDeny(check(edit(other, path.join(m, 'bajzi', 'x.js')), opts));
});

test('a foreign session writes main(R)/runtime/requests/: allow; anything else under runtime/: deny', () => {
  const m = mainRepo();
  const cwd = tmpDir('bajzi-wgf-');
  assert.strictEqual(check(edit(cwd, path.join(m, 'runtime', 'requests', 'x.md')), opts), null);
  assert.strictEqual(check(edit(cwd, path.join(m, 'runtime', 'requests', 'done', 'x.md')), opts), null);
  isDeny(check(edit(cwd, path.join(m, 'runtime', 'HANDOFF.md')), opts));
  isDeny(check(edit(cwd, path.join(m, 'runtime', 'requests-x', 'a.md')), opts));
  isDeny(check(edit(cwd, path.join(m, 'runtime', 'requests', '..', '..', 'bajzi', 'x.js')), opts));   // .. escapes
});

test('installed copies (plugin cache, marketplace clone): deny, the owner included', () => {
  const m = mainRepo();
  const cache = path.join(HOME, '.claude', 'plugins', 'cache', 'bajzi-plugins', 'bajzi', '1.11.0', 'hooks', 'x.js');
  const clone = tree(path.join(HOME, '.claude', 'plugins', 'marketplaces', 'bajzi-plugins'));
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });   // the clone is itself a main checkout
  for (const cwd of [m, tmpDir('bajzi-wgf-'), clone]) {
    for (const f of [cache, path.join(clone, 'bajzi', 'x.js')]) {
      const d = check(edit(cwd, f), opts);
      isDeny(d);
      assert.strictEqual(d.reason, "Installed bajzi copies change only through a release and `claude plugin update`. Send the request to the session started in the bajzi repo main checkout (see 'bajzi plugin changes' in ~/.claude/CLAUDE.md).");
    }
  }
  // A sibling whose name merely starts with bajzi-plugins is not the installed copy.
  const sib = path.join(HOME, '.claude', 'plugins', 'cache', 'bajzi-plugins-other', 'x.js');
  assert.strictEqual(check(edit(m, sib), opts), null);
});

test('a non-bajzi path, and an uncovered tool: allow', () => {
  const m = mainRepo();
  const cwd = tmpDir('bajzi-wgf-');
  assert.strictEqual(check(edit(cwd, path.join(cwd, 'a.js')), opts), null);
  assert.strictEqual(check(edit(m, path.join(cwd, 'a.js')), opts), null);
  assert.strictEqual(check({ tool_name: 'Read', cwd, tool_input: { file_path: path.join(m, 'bajzi', 'x.js') } }, opts), null);
});

test('a relative file_path is resolved against cwd', () => {
  const m = mainRepo();
  const cwd = path.join(tmpDir('bajzi-wgf-'), 'a');
  fs.mkdirSync(cwd);
  const rel = path.relative(cwd, path.join(m, 'bajzi', 'x.js'));
  assert.ok(!path.isAbsolute(rel));
  isDeny(check(edit(cwd, rel), opts));
  assert.strictEqual(check(edit(m, path.join('bajzi', 'x.js')), opts), null);   // the owner, relative
});

test('a repo whose marketplace.json name is not bajzi-plugins: allow', () => {
  const m = mainRepo('someone-else');
  assert.strictEqual(check(edit(tmpDir('bajzi-wgf-'), path.join(m, 'bajzi', 'x.js')), opts), null);
});

test('a non-bajzi marketplace nested inside a bajzi tree does not hide it: the walk goes on up', () => {
  const m = mainRepo();
  const inner = tree(path.join(m, 'fixtures', 'other'), 'other-market');
  isDeny(check(edit(tmpDir('bajzi-wgf-'), path.join(inner, 'x.js')), opts));
});

test('win32 compares paths case-insensitively with either separator (injected platform)', () => {
  const m = mainRepo();
  const cwd = tmpDir('bajzi-wgf-');
  const up = s => s.replace(/plugins/g, 'PLUGINS').replace(/\.claude/g, '.Claude');
  const cache = up(path.join(HOME, '.claude', 'plugins', 'cache', 'bajzi-plugins', 'x.js')).replace(/\\/g, '/');
  isDeny(check(edit(cwd, cache), { home: HOME, platform: 'win32' }));
  assert.strictEqual(check(edit(cwd, cache), { home: HOME, platform: 'linux' }), null);
  // The inbox below main(R), spelled in another case.
  const inbox = path.join(m, 'RUNTIME', 'Requests', 'x.md');
  assert.strictEqual(check(edit(cwd, inbox), { home: HOME, platform: 'win32' }), null);
  isDeny(check(edit(cwd, inbox), { home: HOME, platform: 'linux' }));
});

test('fail open: garbage, null, non-object input, a missing cwd or target, an unreadable marketplace.json', () => {
  const m = mainRepo();
  const f = path.join(m, 'bajzi', 'x.js');
  for (const bad of [null, undefined, 'x', 42, [], {}, { tool_name: 'Edit' }, { tool_name: 'Edit', tool_input: null, cwd: m },
    { tool_name: 'Edit', tool_input: 'x', cwd: m }, { tool_name: 'Edit', tool_input: { file_path: 7 }, cwd: m },
    { tool_name: 'Edit', tool_input: { file_path: '' }, cwd: m }, { tool_name: 'NotebookEdit', tool_input: { file_path: f }, cwd: m },
    { tool_name: 'Edit', tool_input: { file_path: f } }, { tool_name: 'Edit', tool_input: { file_path: f }, cwd: 5 },
    { tool_name: 'Edit', tool_input: { file_path: f }, cwd: '' }]) {
    assert.strictEqual(check(bad, opts), null, JSON.stringify(bad));
  }
  const dir = mainRepo();   // marketplace.json is a directory: unreadable
  fs.rmSync(path.join(dir, '.claude-plugin', 'marketplace.json'));
  fs.mkdirSync(path.join(dir, '.claude-plugin', 'marketplace.json'));
  assert.strictEqual(check(edit(tmpDir('bajzi-wgf-'), path.join(dir, 'bajzi', 'x.js')), opts), null);
  const junk = mainRepo();   // not JSON
  fs.writeFileSync(path.join(junk, '.claude-plugin', 'marketplace.json'), '{nope');
  assert.strictEqual(check(edit(tmpDir('bajzi-wgf-'), path.join(junk, 'bajzi', 'x.js')), opts), null);
  const nul = mainRepo();   // JSON null
  fs.writeFileSync(path.join(nul, '.claude-plugin', 'marketplace.json'), 'null');
  assert.strictEqual(check(edit(tmpDir('bajzi-wgf-'), path.join(nul, 'bajzi', 'x.js')), opts), null);
});

test('CLI: the standalone PreToolUse hook denies a foreign edit, allows the owner, survives bad stdin', () => {
  const m = mainRepo();
  const f = path.join(m, 'bajzi', 'x.js');
  const r = runScript(SCRIPT, JSON.stringify(edit(tmpDir('bajzi-wgf-'), f)));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(o.permissionDecision, 'deny');
  assert.ok(o.permissionDecisionReason.startsWith(`[bajzi:bajzi-writer] bajzi plugin changes are made only by a session started in ${m} `));
  assert.strictEqual(runScript(SCRIPT, JSON.stringify(edit(m, f))).stdout, '');
  for (const stdin of ['', 'not json', '[]', '{"tool_name":"Edit","tool_input":null}']) {
    const b = runScript(SCRIPT, stdin);
    assert.deepStrictEqual([b.code, b.stdout, b.stderr], [0, '', ''], stdin);
  }
});

// notice: the SessionStart inbox count.
function runNotice(stdin, cwd) {
  const home = tmpDir('bajzi-wgnh-');
  const r = spawnSync(process.execPath, [SCRIPT, 'notice'], {
    input: stdin, cwd, encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const inbox = (m, files) => {
  const d = path.join(m, 'runtime', 'requests');
  fs.mkdirSync(path.join(d, 'done'), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
  return d;
};
const MSG = n => `bajzi: ${n} pending plugin change request(s) in runtime/requests/ - handle each, then move it to runtime/requests/done/`;

test('notice: N top-level *.md requests -> the message with N, from cwd or a subdir of the main checkout', () => {
  const m = mainRepo();
  const d = inbox(m, ['2026-10-02-a.md', '2026-10-02-b.md', 'notes.txt']);
  fs.writeFileSync(path.join(d, 'done', 'old.md'), 'x');
  fs.mkdirSync(path.join(d, 'sub.md'));   // a directory does not count
  assert.deepStrictEqual(notice(m), { systemMessage: MSG(2) });
  assert.deepStrictEqual(notice(path.join(m, 'bajzi')), { systemMessage: MSG(2) });
  const r = runNotice(JSON.stringify({ hook_event_name: 'SessionStart', cwd: m }), tmpDir('bajzi-wgn-'));
  assert.deepStrictEqual([r.code, r.stderr], [0, '']);
  assert.deepStrictEqual(JSON.parse(r.stdout), { systemMessage: MSG(2) });
  // No cwd field: falls back to the process cwd.
  assert.deepStrictEqual(JSON.parse(runNotice('{"hook_event_name":"SessionStart"}', m).stdout), { systemMessage: MSG(2) });
});

test('notice: silent with only done/, no inbox, a worktree, a non-bajzi cwd, or garbage stdin', () => {
  const m = mainRepo();
  assert.strictEqual(notice(m), null);   // no inbox
  const d = inbox(m, []);
  fs.writeFileSync(path.join(d, 'done', 'old.md'), 'x');
  assert.strictEqual(notice(m), null);   // only done/
  const w = worktree(m);
  inbox(w, ['x.md']);
  assert.strictEqual(notice(w), null);   // a linked worktree is not the owner
  const other = tmpDir('bajzi-wgn-');
  assert.strictEqual(notice(other), null);
  for (const stdin of [JSON.stringify({ cwd: other }), '', 'not json', '[]', 'null']) {
    const r = runNotice(stdin, other);
    assert.deepStrictEqual([r.code, r.stdout, r.stderr], [0, '', ''], stdin);
  }
});
