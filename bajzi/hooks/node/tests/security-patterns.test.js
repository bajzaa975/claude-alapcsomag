'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { NODE_DIR, tmpDir, runScript } = require('./helpers');
const { RULES, scanText } = require('../lib/security-rules');
const { decide } = require('../security-patterns');

const POST = path.join(NODE_DIR, 'post-tool.js');
// Secret-looking samples are assembled at runtime so no literal secret sits in the source.
const AWS = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const PEM = ['-----BEG', 'IN RSA PRIV', 'ATE KEY-----'].join('');
const PW = ['pass', 'word = "', 'hunter2', 'hunter2"'].join('');

// [rule id, file, text]
const POSITIVE = [
  ['node-exec-interpolated', 'a.js', 'child_process.exec(`ls ${dir}`)'],
  ['py-shell-injection', 'a.py', 'subprocess.run(cmd, shell=True)'],
  ['go-exec-shell', 'a.go', 'exec.Command("bash", "-c", s)'],
  ['eval', 'a.ts', 'const v = eval(input)'],
  ['new-function', 'a.js', 'const f = new Function("a", body)'],
  ['pickle-load', 'a.py', 'obj = pickle.loads(data)'],
  ['yaml-load', 'a.py', 'cfg = yaml.load(fh)'],
  ['torch-load', 'a.py', 'm = torch.load("w.pt")'],
  ['html-injection', 'a.tsx', 'el.innerHTML = userHtml'],
  ['sql-concat', 'a.js', 'db.query("SELECT * FROM t WHERE id = " + id)'],
  ['aws-key-id', 'a.py', `key = "${AWS}"`],
  ['private-key-block', 'k.txt.bak', PEM],
  ['hardcoded-password', 'a.js', PW],
  ['tls-verify-off', 'a.py', 'requests.get(u, verify=False)'],
  ['chmod-777', 'a.sh', 'chmod -R 777 /srv/data'],
  ['gha-event-in-run', '.github/workflows/ci.yml', 'steps:\n  - run: echo "${{ github.event.issue.title }}"'],
];

test('one positive sample per rule', () => {
  assert.deepStrictEqual(POSITIVE.map(p => p[0]).sort(), RULES.map(r => r.id).sort());
  for (const [id, file, text] of POSITIVE) {
    assert.ok(scanText(text, file).some(r => r.id === id), `${id} should fire`);
  }
});

test('extra variants: sql template literal, block run:, document.write', () => {
  assert.ok(scanText('q(`SELECT a FROM t WHERE id = ${id}`)', 'a.js').some(r => r.id === 'sql-concat'));
  const wf = 'jobs:\n  b:\n    steps:\n      - run: |\n          echo hi\n          echo ${{ github.event.comment.body }}\n';
  assert.ok(scanText(wf, '.github/workflows/x.yaml').some(r => r.id === 'gha-event-in-run'));
  assert.ok(scanText('document.write(x)', 'a.js').some(r => r.id === 'html-injection'));
});

test('benign set: zero hits', () => {
  const benign = [
    ['a.js', 'execFile("git", ["log", ref])'],
    ['a.js', 'const re = /x/; re.exec(str); const ok = a === b'],
    ['a.js', 'db.query("SELECT * FROM t WHERE id = ?", [id])'],
    ['a.py', 'cur.execute("SELECT * FROM t WHERE id = %s", (id,))'],
    ['a.py', 'cfg = yaml.safe_load(fh); m = torch.load(p, weights_only=True)'],
    ['a.py', 'subprocess.run(["ls", d], check=True)'],
    ['a.js', 'el.textContent = s; if (a == b) {}'],
    ['a.js', '// the password must be at least 12 chars; ask the user for the password'],
    ['a.js', 'const password = process.env.DB_PASSWORD'],
    ['a.sh', 'chmod 644 file'],
    ['.github/workflows/ci.yml', 'env:\n  T: ${{ github.event.issue.title }}\nrun: echo "$T"'],
  ];
  for (const [file, text] of benign) assert.deepStrictEqual(scanText(text, file).map(r => r.id), [], text);
});

test('extension filter: JS rule silent on .py, doc files skip code rules', () => {
  assert.deepStrictEqual(scanText('el.innerHTML = x', 'a.py'), []);
  assert.deepStrictEqual(scanText('subprocess.run(c, shell=True)', 'a.js'), []);
  assert.deepStrictEqual(scanText('el.innerHTML = x; chmod 777 x', 'README.md'), []);
  assert.deepStrictEqual(scanText('eval(x)', 'notes.txt'), []);
});

test('doc files still get secret rules', () => {
  const ids = f => scanText(`${PEM}
${PW}
${AWS.length ? `k = "${AWS}"` : ''}
eval(x)
el.innerHTML = x`, f).map(r => r.id).sort();
  const want = ['aws-key-id', 'hardcoded-password', 'private-key-block'];
  assert.deepStrictEqual(ids('README.md'), want);
  assert.deepStrictEqual(ids('notes.txt'), want);
});

test('node-exec variants and innerHTML append', () => {
  assert.ok(scanText('cp.exec(`ls ${d}`)', 'a.js').some(r => r.id === 'node-exec-interpolated'));
  assert.ok(scanText("require('child_process').execSync(`git ${x}`)", 'a.js').some(r => r.id === 'node-exec-interpolated'));
  assert.ok(scanText('el.innerHTML += userHtml', 'a.js').some(r => r.id === 'html-injection'));
});

test('writeSeen failure leaves no tmp file and still returns the reminder', () => {
  const fs = require('node:fs');
  const dir = tmpDir('bajzi-sp-');
  const orig = fs.renameSync;
  fs.renameSync = () => { throw new Error('boom'); };
  let r;
  try { r = decide({ session_id: 'rn', tool_name: 'Edit', tool_input: { file_path: 'a.js', new_string: 'eval(x)' } }, dir); } finally { fs.renameSync = orig; }
  assert.ok(r);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('dedup: a second identical edit is silent, another file is not', () => {
  const dir = tmpDir('bajzi-sp-');
  const inp = (f, s = 'x') => ({ session_id: s, tool_name: 'Edit', tool_input: { file_path: f, new_string: 'eval(x)' } });
  const first = decide(inp('/p/a.js'), dir);
  assert.match(first, /^\[bajzi:security-patterns\] Possible security issue in \/p\/a\.js \(eval\)/);
  assert.strictEqual(decide(inp('/p/a.js'), dir), null);
  assert.ok(decide(inp('/p/b.js'), dir));
  assert.ok(decide(inp('/p/a.js', 'other'), dir));
});

test('new text only: MultiEdit edits, Write content, NotebookEdit new_source; old_string ignored', () => {
  const dir = tmpDir('bajzi-sp-');
  const d = (name, ti) => decide({ session_id: 's', tool_name: name, tool_input: ti }, tmpDir('bajzi-sp-'));
  assert.ok(d('MultiEdit', { file_path: 'a.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'eval(z)' }] }));
  assert.ok(d('Write', { file_path: 'a.js', content: 'eval(z)' }));
  assert.ok(d('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'pickle.load(f)' }));
  assert.strictEqual(decide({ session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'a.js', old_string: 'eval(x)', new_string: 'safe(x)' } }, dir), null);
  assert.strictEqual(decide({ session_id: 's', tool_name: 'Read', tool_input: { file_path: 'a.js', new_string: 'eval(x)' } }, dir), null);
});

test('fail-open: unreadable state throws out of decide (caught by runChecks), post-tool exits 0 without output', () => {
  const tmp = tmpDir('bajzi-sp-');
  require('node:fs').writeFileSync(path.join(tmp, 'bajzi-secpat-s9.json'), '{not json');
  const input = { session_id: 's9', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js', new_string: 'eval(x)' }, tool_response: 'ok' };
  const r = runScript(POST, JSON.stringify(input), { TMPDIR: tmp });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('end to end through post-tool.js with an Edit payload', () => {
  const tmp = tmpDir('bajzi-sp-');
  const input = {
    session_id: 'e2e', hook_event_name: 'PostToolUse', tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/run.js', old_string: 'x', new_string: 'const { exec } = require("child_process");\nexec(`git log ${ref}`);\nel.innerHTML = html;' },
    tool_response: { filePath: '/repo/src/run.js', success: true },
  };
  const r = runScript(POST, JSON.stringify(input), { TMPDIR: tmp });
  assert.strictEqual(r.code, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(o.hookEventName, 'PostToolUse');
  assert.match(o.additionalContext, /\[bajzi:security-patterns\] Possible security issue in \/repo\/src\/run\.js \(node-exec-interpolated, html-injection\)/);
  assert.ok(!('permissionDecision' in o));
  assert.strictEqual(runScript(POST, JSON.stringify(input), { TMPDIR: tmp }).stdout, '');
});

test('perf: 200 KB of new text scans in < 100 ms (adversarial and ordinary)', () => {
  const lines = [
    '"SELECT ' + 'a, '.repeat(60) + ' x',
    'password = ' + '"a'.repeat(100),
    '  - run: |\n' + '      echo x\n'.repeat(30),
    'exec(`' + 'a'.repeat(250),
    'const v = foo(bar, baz) + qux("zz");',
  ];
  let text = '';
  while (text.length < 200 * 1024) text += lines.join('\n') + '\n';
  text = text.slice(0, 200 * 1024);
  for (const file of ['a.js', 'a.py', '.github/workflows/x.yml']) {
    const t0 = process.hrtime.bigint();
    scanText(text, file);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 100, `${file}: ${ms} ms`);
  }
});
