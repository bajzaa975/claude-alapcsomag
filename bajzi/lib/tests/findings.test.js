'use strict';
// Findings-file format, parser and close policy (D4-D6).
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../findings.js');

const R1 = `# Findings · s42 · round 1
range: abc1234..def5678
reviewer: opus            # frontmatter alias
verdict: FINDINGS 2       # or CLEAN
files_reviewed: 6

## F1 · blocker · app/billing/retry.py:41
finding: a timed-out payment call is retried without an idempotency key
if_unfixed: a customer whose payment times out can be charged twice
why_severity: wrong behaviour with data/money effect
test: tests/test_retry.py::test_timeout_is_idempotent (to write)

## F2 · minor · app/core/needs_you.py:88
finding: retry loop duplicated from retry.py
if_unfixed: two copies drift; a later fix lands in one of them
why_severity: no behaviour change, maintainability
test: none
`;

const CLEAN = `# Findings · s42 · round 1
range: abc1234..def5678
reviewer: opus
verdict: CLEAN
files_reviewed: 3
`;

// Round-2 file builder: rows = [id, severity, status, location?]
function r2(rows) {
  const open = rows.filter((r) => r[2] !== 'resolved' && r[1] !== 'test-gap').length;
  let s = `# Findings · s42 · round 2\nrange: abc1234..0123abc\nreviewer: opus\n` +
    `verdict: ${open ? `FINDINGS ${open}` : 'CLEAN'}\nfiles_reviewed: 2\n`;
  for (const [id, sev, status, loc] of rows) {
    const gap = sev === 'test-gap';
    s += `\n## ${id} · ${sev} · ${loc || `app/${id}.py:1`}\nfinding: defect ${id}\n` +
      `if_unfixed: users see ${id}\nwhy_severity: ${gap ? `test-gap - no failing case found; ${id} untested` : `rubric ${sev}`}\n` +
      `test: ${gap ? `tests/t.py::test_${id} (to write)` : 'none'}\nstatus: ${status}\n`;
  }
  return s;
}

// Round-1 file with the same rows (status dropped; every finding counts).
function r1(rows) {
  return r2(rows.map(([id, sev, , loc]) => [id, sev, 'open', loc])).replace('round 2', 'round 1')
    .replace(/^status: .*\n/gm, '');
}
// applyClosePolicy with a round 1 holding exactly the round-2 ids (none new, none missing).
const close = (rows, report) => F.applyClosePolicy(r2(rows), report, r1(rows));

// ---------- parse / validate ----------

test('valid round-1 file parses: header, findings, trailing comments stripped', () => {
  const v = F.validate(R1);
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.ok, true);
  const d = v.doc;
  assert.strictEqual(d.slice, 's42');
  assert.strictEqual(d.round, 1);
  assert.strictEqual(d.header.reviewer, 'opus');
  assert.strictEqual(d.header.verdict, 'FINDINGS 2');
  assert.strictEqual(d.findings.length, 2);
  assert.deepStrictEqual(
    [d.findings[0].id, d.findings[0].severity, d.findings[0].location, d.findings[0].file],
    ['F1', 'blocker', 'app/billing/retry.py:41', 'app/billing/retry.py']);
  assert.strictEqual(d.findings[1].if_unfixed, 'two copies drift; a later fix lands in one of them');
});

test('CLEAN file with zero findings validates', () => {
  assert.strictEqual(F.validate(CLEAN).ok, true);
});

test('parse accepts CRLF line endings', () => {
  assert.strictEqual(F.validate(R1.replace(/\n/g, '\r\n')).ok, true);
});

for (const field of ['finding', 'if_unfixed', 'why_severity', 'test']) {
  test(`finding missing "${field}" is rejected and the error names it`, () => {
    const text = R1.replace(new RegExp(`^${field}: .*\\n`, 'm'), ''); // drops it from F1 only
    const v = F.validate(text);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e === `F1: missing field: ${field}`), v.errors.join(' | '));
  });
}

for (const field of ['range', 'reviewer', 'verdict', 'files_reviewed']) {
  test(`header missing "${field}" is rejected and the error names it`, () => {
    const v = F.validate(R1.replace(new RegExp(`^${field}: .*\\n`, 'm'), ''));
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.includes(`header: missing field: ${field}`), v.errors.join(' | '));
  });
}

test('missing title line is rejected', () => {
  const v = F.validate(R1.replace(/^# Findings.*\n/, ''));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('title:')), v.errors.join(' | '));
});

test('finding heading missing severity or location is rejected', () => {
  const v = F.validate(R1.replace('## F2 · minor · app/core/needs_you.py:88', '## F2 · app/core/needs_you.py:88'));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('F2: heading')), v.errors.join(' | '));
});

test('unknown severity is rejected', () => {
  const v = F.validate(R1.replace('· minor ·', '· low ·'));
  assert.ok(v.errors.includes('F2: bad severity: low'), v.errors.join(' | '));
});

test('empty field value counts as missing', () => {
  const v = F.validate(R1.replace(/^if_unfixed: .*$/m, 'if_unfixed:   '));
  assert.ok(v.errors.includes('F1: missing field: if_unfixed'), v.errors.join(' | '));
});

test('verdict count must match the number of findings', () => {
  const v = F.validate(R1.replace('FINDINGS 2', 'FINDINGS 3'));
  assert.ok(v.errors.some((e) => e.startsWith('header: verdict')), v.errors.join(' | '));
  const c = F.validate(R1.replace('FINDINGS 2', 'CLEAN'));
  assert.ok(c.errors.some((e) => e.startsWith('header: verdict')), c.errors.join(' | '));
});

test('duplicate finding id is rejected', () => {
  const v = F.validate(R1.replace('## F2 ·', '## F1 ·'));
  assert.ok(v.errors.includes('F1: duplicate id'), v.errors.join(' | '));
});

test('24 KB cap: a file over 24576 bytes is rejected, one at the cap is not size-rejected', () => {
  const pad = (n) => R1.replace('test: none', `test: ${'x'.repeat(n)}`);
  const base = Buffer.byteLength(R1.replace('test: none', 'test: '), 'utf8');
  const at = pad(F.MAX_BYTES - base);
  assert.strictEqual(Buffer.byteLength(at, 'utf8'), F.MAX_BYTES);
  assert.ok(!F.validate(at).errors.some((e) => e.startsWith('size:')));
  const over = pad(F.MAX_BYTES - base + 1);
  assert.ok(F.validate(over).errors.some((e) => e.startsWith('size:')));
  assert.strictEqual(F.MAX_BYTES, 24 * 1024);
});

test('40-finding cap: 41 findings rejected, 40 accepted', () => {
  const many = (n) => {
    const rows = Array.from({ length: n }, (_, i) => [`F${i + 1}`, 'nit', 'x']);
    return r2(rows).replace('round 2', 'round 1').replace(/^status: .*\n/gm, '')
      .replace(/verdict: .*/, `verdict: FINDINGS ${n}`);
  };
  assert.deepStrictEqual(F.validate(many(40)).errors, []);
  assert.ok(F.validate(many(41)).errors.some((e) => e.startsWith('count:')));
});

// ---------- round 2 status ----------

test('round 2: status resolved/open parses', () => {
  const v = F.validate(r2([['F1', 'blocker', 'resolved'], ['F2', 'minor', 'open']]));
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.doc.findings.map((f) => f.status), ['resolved', 'open']);
});

test('round 2: missing status is rejected and named', () => {
  const v = F.validate(r2([['F1', 'blocker', 'resolved'], ['F2', 'minor', 'open']]).replace('status: open\n', ''));
  assert.ok(v.errors.includes('F2: missing field: status'), v.errors.join(' | '));
});

test('round 2: status other than resolved|open is rejected', () => {
  const v = F.validate(r2([['F1', 'major', 'fixed']]));
  assert.ok(v.errors.includes('F1: bad status: fixed'), v.errors.join(' | '));
});

test('round 2: verdict counts only open findings (all resolved = CLEAN)', () => {
  assert.deepStrictEqual(F.validate(r2([['F1', 'major', 'resolved']])).errors, []);
});

// ---------- stripForFixer / stripSeverity ----------

test('stripForFixer keeps ids/locations/findings/tests, drops severity, why_severity, if_unfixed', () => {
  const out = F.stripForFixer(R1);
  for (const s of ['## F1 · app/billing/retry.py:41', '## F2 · app/core/needs_you.py:88',
    'finding: retry loop duplicated from retry.py', 'test: tests/test_retry.py::test_timeout_is_idempotent (to write)']) {
    assert.ok(out.includes(s), `missing: ${s}`);
  }
  for (const s of ['blocker', 'minor', 'why_severity', 'if_unfixed', 'verdict', 'charged twice']) {
    assert.ok(!out.includes(s), `leaked: ${s}`);
  }
});

test('stripSeverity keeps the consequence, drops severity, why_severity and blind_severity', () => {
  const debt = F.mergeToDebt('', F.parse(R1).findings, { origin: 's42', parked: '2026-09-24' })
    .replace('parked: 2026-09-24', 'parked: 2026-09-24\nblind_severity: major');
  const out = F.stripSeverity(debt);
  assert.ok(out.includes('## s42/F1 · app/billing/retry.py:41'));
  assert.ok(out.includes('if_unfixed: a customer whose payment times out can be charged twice'));
  for (const s of ['blocker', 'minor', 'why_severity', 'blind_severity', 'major']) {
    assert.ok(!out.includes(s), `leaked: ${s}`);
  }
});

test('strip functions refuse an invalid file', () => {
  const bad = R1.replace(/^if_unfixed: .*\n/m, '');
  assert.throws(() => F.stripForFixer(bad), /if_unfixed/);
  assert.throws(() => F.stripSeverity(bad), /if_unfixed/);
});

// ---------- close policy (D4) ----------

const byId = (arr) => arr.map((x) => x.id).sort();

test('D4: resolved finding of any severity closes (goes nowhere)', () => {
  const r = close([['F1', 'blocker', 'resolved'], ['F2', 'nit', 'resolved']], 'FIX s42 DONE 2/2');
  assert.deepStrictEqual(byId(r.resolved), ['F1', 'F2']);
  assert.deepStrictEqual([r.owner, r.debt], [[], []]);
});

test('D4: open blocker OUT_OF_SLICE -> owner, severity unchanged', () => {
  const r = close([['F1', 'blocker', 'open']], 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity, x.original_severity]), [['F1', 'blocker', 'blocker']]);
  assert.deepStrictEqual(r.debt, []);
});

test('D4: open major OUT_OF_SLICE -> owner, severity unchanged', () => {
  const r = close([['F1', 'major', 'open']], 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity]), [['F1', 'major']]);
});

test('D4: open minor OUT_OF_SLICE -> debt', () => {
  const r = close([['F1', 'minor', 'open']], 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual([byId(r.debt), r.owner], [['F1'], []]);
});

test('D4: open nit OUT_OF_SLICE -> debt', () => {
  const r = close([['F1', 'nit', 'open']], 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual([byId(r.debt), r.owner], [['F1'], []]);
});

for (const [from, to] of [['nit', 'minor'], ['minor', 'major'], ['major', 'blocker'], ['blocker', 'blocker']]) {
  test(`D4: open ${from} ATTEMPTED -> escalated to ${to} -> owner, with the reason`, () => {
    const r = close([['F1', from, 'open']], 'FIX s42 DONE 0/1\nF1 ATTEMPTED: needs a schema change');
    assert.deepStrictEqual(r.debt, []);
    assert.strictEqual(r.owner.length, 1);
    const o = r.owner[0];
    assert.deepStrictEqual([o.severity, o.original_severity], [to, from]);
    assert.strictEqual(o.if_unfixed, 'users see F1');
    assert.match(o.reason, /needs a schema change/);
  });
}

test('D4: open with no fixer mark (fixer claimed fixed) counts as attempted -> escalated -> owner', () => {
  const r = close([['F1', 'minor', 'open']], 'FIX s42 DONE 1/1');
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity]), [['F1', 'major']]);
  assert.deepStrictEqual(r.debt, []);
});

test('D4: new round-2 finding was introduced by the fix (in-slice) -> owner as rated, never debt', () => {
  const round2 = r2([['F1', 'blocker', 'resolved'], ['F2', 'minor', 'open'], ['F3', 'minor', 'open'], ['F4', 'major', 'open'], ['F5', 'nit', 'open']]);
  const round1 = r1([['F1', 'blocker'], ['F2', 'minor']]);
  const r = F.applyClosePolicy(round2, 'FIX s42 DONE 1/2\nF3 OUT_OF_SLICE', round1);
  assert.deepStrictEqual(r.debt, []);
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity, x.original_severity]).sort(),
    [['F2', 'major', 'minor'], ['F3', 'minor', 'minor'], ['F4', 'major', 'major'], ['F5', 'nit', 'nit']]);
  assert.match(r.owner.find((x) => x.id === 'F3').reason, /new in round 2/);
});

test('D4: a round-1 id missing from round 2 is unaccounted -> owner (probe: blocker + CLEAN round 2)', () => {
  const round1 = r1([['F1', 'blocker'], ['F2', 'nit']]);
  const r = F.applyClosePolicy(r2([['F2', 'nit', 'resolved']]), 'FIX s42 DONE 2/2', round1);
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity]), [['F1', 'blocker']]);
  assert.strictEqual(r.owner[0].if_unfixed, 'users see F1');
  assert.match(r.owner[0].reason, /missing from round 2/);
  const clean = F.applyClosePolicy(r2([]), 'FIX s42 DONE 2/2', round1);
  assert.deepStrictEqual(byId(clean.owner), ['F1', 'F2']);
});

test('applyClosePolicy requires the round-1 file of the same slice', () => {
  const two = r2([['F1', 'nit', 'open']]);
  assert.throws(() => F.applyClosePolicy(two, 'FIX s42 DONE 0/1'), /round1/);
  assert.throws(() => F.applyClosePolicy(two, '', two), /round1/);
  assert.throws(() => F.applyClosePolicy(two, '', r1([['F1', 'nit']]).replace('s42', 's43')), /round1/);
});

test('D4: fixer report accepts ids listed with leading bullets/spaces', () => {
  const r = close([['F1', 'nit', 'open']], 'FIX s42 DONE 0/1\n  - F1 OUT_OF_SLICE');
  assert.deepStrictEqual(byId(r.debt), ['F1']);
});

test('applyClosePolicy refuses a round-1 file and an invalid file', () => {
  assert.throws(() => F.applyClosePolicy(R1, 'FIX s42 DONE 2/2', R1), /round 2/);
  assert.throws(() => F.applyClosePolicy(r2([['F1', 'nit', 'open']]).replace(/^test: .*\n/m, ''), '', r1([['F1', 'nit']])),
    /F1: missing field: test/);
});

// ---------- debt: mergeToDebt / debtCapHit (D6) ----------

function debtItems(files) { // files = list of file paths, one debt item each
  return files.map((file, i) => ({
    id: `F${i + 1}`, severity: 'minor', location: `${file}:${i + 1}`, file,
    finding: `f${i}`, if_unfixed: `u${i}`, why_severity: 'maint', test: 'none',
  }));
}

test('mergeToDebt creates a valid debt.md with origin + parked and prefixed ids', () => {
  const text = F.mergeToDebt('', F.parse(R1).findings, { origin: 's42', parked: '2026-09-24' });
  const v = F.validate(text);
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.doc.kind, 'debt');
  assert.deepStrictEqual(v.doc.findings.map((f) => [f.id, f.origin, f.parked]),
    [['s42/F1', 's42', '2026-09-24'], ['s42/F2', 's42', '2026-09-24']]);
});

test('mergeToDebt appends to an existing debt.md and is idempotent per id', () => {
  const a = F.mergeToDebt('', debtItems(['a.py']), { origin: 's1', parked: '2026-09-01' });
  const b = F.mergeToDebt(a, debtItems(['b.py']), { origin: 's2', parked: '2026-09-02' });
  const c = F.mergeToDebt(b, debtItems(['b.py']), { origin: 's2', parked: '2026-09-03' });
  assert.strictEqual(c, b);
  assert.deepStrictEqual(F.parse(c).findings.map((f) => f.id), ['s1/F1', 's2/F1']);
});

test('debt entry missing origin or parked is rejected and named', () => {
  const text = F.mergeToDebt('', debtItems(['a.py']), { origin: 's1', parked: '2026-09-01' });
  assert.ok(F.validate(text.replace(/^origin: .*\n/m, '')).errors.includes('s1/F1: missing field: origin'));
  assert.ok(F.validate(text.replace(/^parked: .*\n/m, '')).errors.includes('s1/F1: missing field: parked'));
});

test('debt cap: 15 items across files is not a hit, 16 is', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => `f${i}.py`);
  const at = F.mergeToDebt('', debtItems(files(15)), { origin: 's', parked: 'd' });
  const over = F.mergeToDebt('', debtItems(files(16)), { origin: 's', parked: 'd' });
  assert.deepStrictEqual(F.debtCapHit(at), { hit: false, total: 15, reasons: [] });
  const h = F.debtCapHit(over);
  assert.strictEqual(h.hit, true);
  assert.match(h.reasons.join(), /16 items > 15/);
});

test('debt cap: 3 items in one file is not a hit, 4 is (file = location without :line)', () => {
  const at = F.mergeToDebt('', debtItems(['x.py', 'x.py', 'x.py', 'y.py']), { origin: 's', parked: 'd' });
  assert.strictEqual(F.debtCapHit(at).hit, false);
  const over = F.mergeToDebt('', debtItems(['x.py', 'x.py', 'x.py', 'x.py']), { origin: 's', parked: 'd' });
  const h = F.debtCapHit(over);
  assert.strictEqual(h.hit, true);
  assert.match(h.reasons.join(), /x\.py: 4 items > 3/);
});

test('debt cap: empty or missing debt.md is not a hit', () => {
  assert.strictEqual(F.debtCapHit('').hit, false);
  assert.strictEqual(F.debtCapHit(undefined).hit, false);
});

test('debt cap fails closed on an unparseable debt.md', () => {
  const h = F.debtCapHit('# Debt\n\n## s1/F1 · minor · a.py:1\nfinding: x\n');
  assert.strictEqual(h.hit, true);
  assert.match(h.reasons.join(), /invalid debt\.md/);
});

test('mergeToDebt validates its arguments first and names the missing one', () => {
  const items = debtItems(['a.py']);
  assert.throws(() => F.mergeToDebt('', items, { parked: 'd' }), /mergeToDebt: missing argument: origin/);
  assert.throws(() => F.mergeToDebt('', items, { origin: 's1' }), /mergeToDebt: missing argument: parked/);
  assert.throws(() => F.mergeToDebt('', items), /mergeToDebt: missing argument: origin/);
  assert.throws(() => F.mergeToDebt('', undefined, { origin: 's', parked: 'd' }), /mergeToDebt: missing argument: findings/);
  const noConsequence = items.map((f) => ({ ...f, if_unfixed: '' }));
  assert.throws(() => F.mergeToDebt('', noConsequence, { origin: 's', parked: 'd' }), /s\/F1: missing field: if_unfixed/);
  assert.throws(() => F.mergeToDebt(R1, items, { origin: 's', parked: 'd' }), /not a debt file/);
});

test('mergeToDebt refuses to write a debt.md over 24 KB; the existing file stays readable', () => {
  const big = debtItems(['a.py']).map((f) => ({ ...f, finding: 'x'.repeat(F.MAX_BYTES / 2) }));
  const a = F.mergeToDebt('', big, { origin: 's1', parked: 'd' });
  assert.throws(() => F.mergeToDebt(a, big, { origin: 's2', parked: 'd' }), /DEBT CAP HIT: debt\.md would be \d+ bytes > 24576/);
  assert.strictEqual(F.validate(a).ok, true);
  assert.strictEqual(F.debtCapHit(a).hit, false);
});

test('brief review: slice line only when the slice file exists and slice is not debt; GRAPH stays', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
  g('init', '-q'); fs.writeFileSync(path.join(d, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'a');
  fs.writeFileSync(path.join(d, 'a'), '2'); g('commit', '-qam', 'b');
  const brief = (s) => fs.readFileSync(path.join(d, execFileSync('node', [cli, 'brief', 'review', s, '1', 'HEAD~1..HEAD'], { cwd: d, encoding: 'utf8' }).trim()), 'utf8');
  assert.doesNotMatch(brief('s1'), /^slice:/m);
  fs.mkdirSync(path.join(d, 'runtime/slices'), { recursive: true });
  for (const s of ['s1', 'debt']) fs.writeFileSync(path.join(d, `runtime/slices/${s}.md`), 'x');
  const b = brief('s1');
  assert.match(b, /^slice: runtime\/slices\/s1\.md -- Read it; check every acceptance item against the diff\.$/m);
  assert.match(b, /^GRAPH: /m);
  const dbt = brief('debt');
  assert.doesNotMatch(dbt, /^slice:/m);
  assert.match(dbt, /^GRAPH: /m);
  fs.rmSync(d, { recursive: true, force: true });
});

test('brief review: known line lists existing debt/owner files; round 1, not debt', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'known-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
  g('init', '-q'); fs.writeFileSync(path.join(d, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'a');
  fs.writeFileSync(path.join(d, 'a'), '2'); g('commit', '-qam', 'b');
  const brief = (s, r = '1') => fs.readFileSync(path.join(d, execFileSync('node', [cli, 'brief', 'review', s, r, 'HEAD~1..HEAD'], { cwd: d, encoding: 'utf8' }).trim()), 'utf8');
  assert.doesNotMatch(brief('s1'), /^known:/m);
  const dir = path.join(d, 'runtime/findings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'debt.md'), 'x');
  let b = brief('s1');
  assert.match(b, /^known: \S*debt\.md -- Read them; do not re-raise a recorded minor\/nit at the same path\.$/m);
  assert.doesNotMatch(b, /needs-owner/); assert.match(b, /^GRAPH: /m);
  fs.writeFileSync(path.join(dir, 'needs-owner.md'), 'x');
  assert.match(brief('s1'), /^known: \S*debt\.md, \S*needs-owner\.md/m);
  fs.rmSync(path.join(dir, 'debt.md'));
  assert.match(brief('s1'), /^known: \S*needs-owner\.md -- /m);
  fs.writeFileSync(path.join(dir, 'debt.md'), 'x');
  assert.doesNotMatch(brief('debt'), /^known:/m);
  fs.writeFileSync(path.join(dir, 's1-r1.md'), 'x'); fs.writeFileSync(path.join(dir, 's1-r1.report.md'), 'x');
  assert.doesNotMatch(brief('s1', '2'), /^known:/m);
  fs.rmSync(d, { recursive: true, force: true });
});

test('brief review: round 2 fix diff (ancestor, rewritten, equal, round 1, debt)', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fixdiff-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' }).trim();
  const w = (f, c) => fs.writeFileSync(path.join(d, f), c);
  g('init', '-q'); w('a', '1\n'); g('add', '.'); g('commit', '-qm', 'a');
  const base = g('rev-parse', 'HEAD');
  w('a', '2\n'); g('commit', '-qam', 'b'); const r1 = g('rev-parse', 'HEAD');
  const dir = path.join(d, 'runtime/findings'); fs.mkdirSync(dir, { recursive: true });
  for (const s of ['s1', 'debt']) {
    w(`runtime/findings/${s === 'debt' ? 'debt' : 's1-r1'}.md`, s === 'debt' ? 'x' : `# Findings\nrange: ${base}..${r1}\n`);
    w(`runtime/findings/${s === 'debt' ? 'debt' : 's1-r1'}.report.md`, 'x');
  }
  const brief = (s, r, range) => fs.readFileSync(path.join(d, execFileSync('node', [cli, 'brief', 'review', s, r, range], { cwd: d, encoding: 'utf8' }).trim()), 'utf8');
  assert.doesNotMatch(brief('s1', '1', `${base}..${r1}`), /fix diff/);
  assert.match(brief('s1', '2', `${base}..${r1}`), /^fix diff: n\/a$/m); // equal tips
  w('a', '2\n3\n'); g('commit', '-qam', 'c'); const tip = g('rev-parse', 'HEAD');
  const b = brief('s1', '2', `${base}..${tip}`);
  const fp = path.join(d, 'runtime/briefs/s1-r2.fix.diff');
  const n = fs.readFileSync(fp, 'utf8').split('\n').length;
  assert.match(b, new RegExp(`^fix diff: \\S*s1-r2\\.fix\\.diff -- the fixer's changes only \\(${n} lines\\)\\. Read it first;`, 'm'));
  assert.match(b, /^diff: /m);
  assert.doesNotMatch(fs.readFileSync(fp, 'utf8'), /^-1$/m);
  g('checkout', '-q', '-b', 'alt', base); w('a', 'z\n'); g('commit', '-qam', 'alt');
  assert.match(brief('s1', '2', `${base}..HEAD`), /^fix diff: n\/a$/m); // r1 tip not an ancestor
  assert.match(brief('debt', '2', `${base}..HEAD`), /^fix diff: n\/a$/m);
  w('runtime/findings/s1-r1.md', `# Findings\nrange: ${base}..${'0'.repeat(40)}\n`); // unknown commit
  assert.match(brief('s1', '2', `${base}..HEAD`), /^fix diff: n\/a$/m);
  w('runtime/findings/s1-r1.md', '# Findings\n'); // no range line
  assert.match(brief('s1', '2', `${base}..HEAD`), /^fix diff: n\/a$/m);
  w('runtime/findings/s1-r1.md', `# Findings\nrange: ${base}..${r1}\n`);
  assert.doesNotMatch(b, /Read all of it/); // fix diff present: no conflicting full-diff instruction
  fs.rmSync(d, { recursive: true, force: true });
});

test('brief review: review-policy is read at the base commit; policy-changed when the diff touches it', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
  const brief = (range) => {
    const p = execFileSync('node', [cli, 'brief', 'review', 's1', '1', range], { cwd: d, encoding: 'utf8' }).trim();
    return fs.readFileSync(path.join(d, p), 'utf8');
  };
  g('init', '-q'); fs.writeFileSync(path.join(d, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'c0');
  fs.writeFileSync(path.join(d, 'a'), '2'); g('commit', '-qam', 'c1');
  // no policy anywhere: brief unchanged
  let b = brief('HEAD~1..HEAD');
  assert.doesNotMatch(b, /^policy/m); assert.match(b, /^GRAPH: /m);
  assert.ok(!fs.existsSync(path.join(d, 'runtime/briefs/s1-r1.policy.md')));
  // tip-only policy: no policy line, but policy-changed
  fs.mkdirSync(path.join(d, 'docs'));
  fs.writeFileSync(path.join(d, 'docs/review-policy.md'), 'TIP');
  g('add', '.'); g('commit', '-qm', 'c2');
  b = brief('HEAD~1..HEAD');
  assert.doesNotMatch(b, /^policy: /m); assert.match(b, /^policy-changed: yes$/m);
  // base has policy, tip changed it: base content wins
  fs.writeFileSync(path.join(d, 'docs/review-policy.md'), 'CHANGED'); g('commit', '-qam', 'c3');
  b = brief('HEAD~1..HEAD');
  assert.match(b, /^policy: runtime\/briefs\/s1-r1\.policy\.md -- Read it; do not flag what it lists as accepted\.$/m);
  assert.match(b, /^policy-changed: yes$/m); assert.match(b, /^GRAPH: /m);
  assert.strictEqual(fs.readFileSync(path.join(d, 'runtime/briefs/s1-r1.policy.md'), 'utf8'), 'TIP');
  // base has policy, diff does not touch it
  fs.writeFileSync(path.join(d, 'a'), '3'); g('commit', '-qam', 'c4');
  b = brief('HEAD~1..HEAD');
  assert.match(b, /^policy: /m); assert.doesNotMatch(b, /policy-changed/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('brief review: always-read listing, missing paths skipped, caps warn, base-vs-tip', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'policy2-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
  const brief = () => {
    const p = execFileSync('node', [cli, 'brief', 'review', 's1', '1', 'HEAD~1..HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    return fs.readFileSync(path.join(d, p), 'utf8');
  };
  fs.mkdirSync(path.join(d, 'docs'));
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) fs.writeFileSync(path.join(d, f), f);
  const checks = Array.from({ length: 12 }, (_, i) => `- chk${i}: must hold` +
    (i === 3 ? '\n  - keep3 sub' : '') + (i === 10 ? '\n  wrapped10 continuation\n  - sub10 bullet' : '')).join('\n');
  fs.writeFileSync(path.join(d, 'docs/review-policy.md'),
    `## Checks\n${checks}\n\n## Always read\n- a\n- \`missing\`\n- b\n- c\n- d\n- e\n- f\n`);
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'c0');
  // tip tries to add a path and drop the policy contents: base wins
  fs.writeFileSync(path.join(d, 'docs/review-policy.md'), '## Always read\n- f\n'); g('commit', '-qam', 'c1');
  const b = brief();
  assert.match(b, /^always read: a, b, c, d$/m); // first 5 entries = a, missing, b, c, d; missing skipped
  assert.match(b, /^policy-warning: 12 checks entries \(cap 10\), extra entries ignored; 7 always read entries \(cap 5\), extra entries ignored$/m);
  assert.match(b, /^policy-changed: yes$/m);
  const pol = fs.readFileSync(path.join(d, 'runtime/briefs/s1-r1.policy.md'), 'utf8');
  assert.match(pol, /chk9:/); assert.match(pol, /keep3 sub/); assert.doesNotMatch(pol, /chk10:|wrapped10|sub10|chk11:/);
  assert.doesNotMatch(pol, /^- (f|`missing`)$/m);
  fs.rmSync(d, { recursive: true, force: true });
});

test('dispatch.md "The brief holds:" names every line prefix brief review emits', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'findings-cli.js'), 'utf8');
  const block = src.slice(src.indexOf('const lines = [', src.indexOf("kind === 'review'")), src.indexOf('text = `${lines.join'));
  const emitted = [...new Set([...block.matchAll(/[`']([A-Za-z][\w -]*?):[ `'$]/g)].map((m) => m[1]))].sort();
  const names = {
    'slice_id': '`slice_id/round/range` line', 'GRAPH': 'code-review-graph marker line', 'diff': 'the diff path',
    'slice': '`slice:` line', 'policy': '`policy:` line', 'always read': '`always read:`', 'policy-warning': '`policy-warning:`',
    'policy-changed': '`policy-changed: yes`', 'known': '`known:` line', 'round-1 findings': 'round-1 file',
    'fixer report': 'fixer report paths', 'fix diff': '`fix diff:` line', 'changed files': 'changed-file list',
  };
  assert.deepStrictEqual(emitted, Object.keys(names).sort());
  const d = fs.readFileSync(path.join(root, 'skills', 'lib', 'dispatch.md'), 'utf8').replace(/\s+/g, ' ');
  const s = d.slice(d.indexOf('The brief holds:'), d.indexOf('So it stays small'));
  for (const [k, phrase] of Object.entries(names)) assert.ok(s.includes(phrase), `${k}: ${phrase}`);
});

test('FC slice: fifth acceptance line verbatim after the unchanged four; fixer template line + debt exception', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  fs.mkdirSync(path.join(d, 'runtime/slices'), { recursive: true });
  try {
  const acc = 'tests first and seen RED; a major mutation check';
  fs.writeFileSync(path.join(d, 'runtime/slices/s1.md'), `# Slice · s1\ntier: 2\nfiles: a.js\nacceptance: ${acc}\ntest: node --test a\n`);
  const out = execFileSync('node', [cli, 'slice', 's1'], { cwd: d, encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepStrictEqual(out, ['agent: bajzi:implementer', 'tier: 2', 'files: a.js', 'test: node --test a', `acceptance: ${acc}`]);
  const disp = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'lib', 'dispatch.md'), 'utf8');
  assert.match(disp, /<the \.fixer\.md file, verbatim>\nslice acceptance: <acceptance: from FC slice; omit this line for debt>\nTime matters/);
  assert.match(disp, /debt drain leaves it out/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'fix', 'SKILL.md'), 'utf8'), /`files:`, `test:` and `acceptance:`/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---------- test-gap severity (speed rules) ----------

const GAP_R1 = r1([['F1', 'major'], ['F2', 'test-gap']]);

test('test-gap severity validates in a findings file and is refused in a debt file', () => {
  assert.strictEqual(F.TEST_GAP, 'test-gap');
  assert.ok(!F.SEVERITIES.includes('test-gap'));
  assert.deepStrictEqual(F.validate(GAP_R1).errors, []);
  const debt = '# Debt\n\n## s42/F2 · test-gap · app/F2.py:1\nfinding: f\nif_unfixed: u\n' +
    'why_severity: test-gap - no failing case found; x\ntest: tests/t.py::t (to write)\norigin: s42\nparked: 2026-01-01\n';
  const v = F.validate(debt);
  assert.ok(v.errors.includes('s42/F2: a test gap never parks in debt.md'), v.errors.join(' | '));
  assert.strictEqual(F.debtCapHit(debt).hit, true);
});

test('test-gap requires the attestation why_severity and a named test', () => {
  const noAtt = GAP_R1.replace('test-gap - no failing case found; F2 untested', 'rubric test-gap');
  const v = F.validate(noAtt);
  assert.ok(v.errors.some((e) => e.startsWith('F2: test-gap why_severity must start "test-gap - no failing case found"')), v.errors.join(' | '));
  const none = GAP_R1.replace('tests/t.py::test_F2 (to write)', 'None');
  assert.ok(F.validate(none).errors.includes('F2: test-gap must name the test to write (test: none is not a test gap)'));
});

test('verdict excludes test gaps: FINDINGS n counts only other findings; only test gaps = CLEAN', () => {
  assert.ok(GAP_R1.includes('verdict: FINDINGS 1'));
  assert.deepStrictEqual(F.validate(GAP_R1).errors, []);
  assert.ok(F.validate(GAP_R1.replace('FINDINGS 1', 'FINDINGS 2')).errors.some((e) => e.startsWith('header: verdict')));
  const only = r1([['F2', 'test-gap']]);
  assert.ok(only.includes('verdict: CLEAN'));
  assert.deepStrictEqual(F.validate(only).errors, []);
  assert.ok(F.validate(only.replace('CLEAN', 'FINDINGS 1')).errors.some((e) => e.startsWith('header: verdict')));
});

test('round 2: an open test gap does not count in the verdict', () => {
  const t = r2([['F1', 'major', 'resolved'], ['F2', 'test-gap', 'open']]);
  assert.ok(t.includes('verdict: CLEAN'));
  assert.deepStrictEqual(F.validate(t).errors, []);
});

test('stripForFixer drops test-gap findings; only test gaps -> empty fixer copy', () => {
  const out = F.stripForFixer(GAP_R1);
  assert.ok(out.includes('## F1 ·') && !out.includes('F2') && !out.includes('test_F2'));
  const empty = F.stripForFixer(r1([['F2', 'test-gap']]));
  assert.ok(!empty.includes('## '));
});

test('D4: open test-gap in round 2 -> testGaps, never owner or debt, whatever the fixer report says', () => {
  for (const report of ['FIX s42 DONE 1/2', 'FIX s42 DONE 0/2\nF2 OUT_OF_SLICE', 'FIX s42 DONE 0/2\nF2 ATTEMPTED: x']) {
    const r = close([['F1', 'major', 'resolved'], ['F2', 'test-gap', 'open']], report);
    assert.deepStrictEqual([byId(r.testGaps), r.owner, r.debt, byId(r.resolved)], [['F2'], [], [], ['F1']]);
  }
});

test('D4: a round-1 test gap absent from round 2 is not unaccounted', () => {
  const r = F.applyClosePolicy(r2([['F1', 'major', 'resolved']]), 'FIX s42 DONE 1/1', GAP_R1);
  assert.deepStrictEqual([r.owner, r.debt, r.testGaps], [[], [], []]);
  assert.deepStrictEqual(byId(r.resolved), ['F1']);
});

test('D4: a test gap new in round 2 -> testGaps, not owner', () => {
  const r = F.applyClosePolicy(r2([['F1', 'major', 'resolved'], ['F3', 'test-gap', 'open']]), 'FIX s42 DONE 1/1', r1([['F1', 'major']]));
  assert.deepStrictEqual([byId(r.testGaps), r.owner], [['F3'], []]);
});

test('mergeToDebt refuses a test-gap item', () => {
  const item = { ...F.parse(GAP_R1).findings[1], origin: 's42', parked: 'd' };
  assert.throws(() => F.mergeToDebt('', [item], { origin: 's42', parked: '2026-01-01' }), /test gap never parks in debt/);
});

// ---------- FC sprint / FC gaps ----------

function cliRepo(prefix) {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync, spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'findings-cli.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' }).trim();
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  const run = (...a) => spawnSync('node', [cli, ...a], { cwd: d, encoding: 'utf8' });
  return { fs, path, d, g, w, run, rm: () => fs.rmSync(d, { recursive: true, force: true }) };
}
const sliceDoc = (id, tier, files, acc, test) => `# Slice · ${id}\ntier: ${tier}\nfiles: ${files}\nacceptance: ${acc}\ntest: ${test}\n`;

test('FC sprint: writes <stem>.md (lowest tier, union files, joined acceptance, distinct tests) and prints the range from the oldest implement commit', () => {
  const t = cliRepo('sprint-');
  try {
    t.g('init', '-q'); t.w('a', '0'); t.g('add', '.'); t.g('commit', '-qm', 'base');
    const base = t.g('rev-parse', 'HEAD');
    t.w('runtime/slices/sp-t10.md', sliceDoc('sp-t10', 3, 'x.js', 'ten', 'none'));
    t.w('runtime/slices/sp-t2.md', sliceDoc('sp-t2', 2, 'b.js, c.js', 'two', 'node --test b'));
    t.w('runtime/slices/sp-t1.md', sliceDoc('sp-t1', 1, 'a.js, b.js', 'one', 'node --test a'));
    t.w('runtime/slices/sp-t3.md', sliceDoc('sp-t3', 2, 'd.js', 'three', 'node --test b'));
    t.w('runtime/slices/spx-t1.md', sliceDoc('spx-t1', 1, 'zzz', 'other', 'zzz'));
    for (const n of [1, 2]) { t.w(`f${n}`, 'x'); t.g('add', `f${n}`); t.g('commit', '-qm', `sp-t${n}: implement`); }
    t.w('f3', 'x'); t.g('add', 'f3'); t.g('commit', '-qm', 'sp-t3: fix r1 findings');
    const tip = t.g('rev-parse', 'HEAD');
    const r = t.run('sprint', 'sp');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.stdout.trim().split('\n'), ['slice: runtime/slices/sp.md', `range: ${base}..${tip}`]);
    const out = t.fs.readFileSync(t.path.join(t.d, 'runtime/slices/sp.md'), 'utf8');
    assert.strictEqual(out, '# Slice · sp\ngenerated: FC sprint from sp-t1, sp-t2, sp-t3, sp-t10\ntier: 1\n' +
      'files: a.js, b.js, c.js, d.js, x.js\nacceptance: sp-t1: one; sp-t2: two; sp-t3: three; sp-t10: ten\n' +
      'test: node --test a && node --test b\n');
    const s = t.run('slice', 'sp'); // the generated file parses with the existing slice command
    assert.strictEqual(s.status, 0, s.stderr);
    assert.match(s.stdout, /^agent: bajzi:implementer-risk\ntier: 1\n/);
  } finally { t.rm(); }
});

test('FC sprint: no <stem>-t*.md or no implement commit -> exit 2, nothing written', () => {
  const t = cliRepo('sprint2-');
  try {
    t.g('init', '-q'); t.w('a', '0'); t.g('add', '.'); t.g('commit', '-qm', 'base');
    let r = t.run('sprint', 'sp');
    assert.strictEqual(r.status, 2); assert.match(r.stderr, /no slices runtime\/slices\/sp-t\*\.md/);
    t.w('runtime/slices/sp-t1.md', sliceDoc('sp-t1', 2, 'a.js', 'one', 'none'));
    r = t.run('sprint', 'sp');
    assert.strictEqual(r.status, 2); assert.match(r.stderr, /no "sp-t<N>: implement" commit; nothing to review/);
    assert.ok(!t.fs.existsSync(t.path.join(t.d, 'runtime/slices/sp.md')));
    assert.strictEqual(t.run('sprint', 'Bad Id').status, 2);
  } finally { t.rm(); }
});

test('FC gaps: appends open test gaps once per id and prints the count', () => {
  const t = cliRepo('gaps-');
  try {
    t.w('runtime/findings/s42-r1.md', GAP_R1);
    let r = t.run('gaps', 'runtime/findings/s42-r1.md');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), 'test gaps: 1 new, 1 open -> runtime/findings/test-gaps.md');
    const p = t.path.join(t.d, 'runtime/findings/test-gaps.md');
    const txt = t.fs.readFileSync(p, 'utf8');
    assert.strictEqual(txt, '# Test gaps\n\n- s42/F2 · app/F2.py:1 · defect F2 · tests/t.py::test_F2 (to write)\n');
    r = t.run('gaps', 'runtime/findings/s42-r1.md');
    assert.strictEqual(r.stdout.trim(), 'test gaps: 0 new, 1 open -> runtime/findings/test-gaps.md');
    assert.strictEqual(t.fs.readFileSync(p, 'utf8'), txt);
    t.w('runtime/findings/s43-r1.md', r1([['F1', 'major']]).replace('s42', 's43'));
    assert.strictEqual(t.run('gaps', 'runtime/findings/s43-r1.md').stdout.trim(), 'test gaps: none');
    assert.strictEqual(t.run('gaps').status, 2);
    // validate prints the test-gap count; copy fixer says CLEAN when only gaps remain
    assert.strictEqual(t.run('validate', 'runtime/findings/s42-r1.md').stdout.trim(), 'FINDINGS 1 · blocker 0 · major 1 · minor 0 · nit 0 · test-gap 1');
    t.w('runtime/findings/s44-r1.md', r1([['F2', 'test-gap']]).replace('s42', 's44'));
    assert.strictEqual(t.run('copy', 'fixer', 'runtime/findings/s44-r1.md').stdout.trim(), 'CLEAN: nothing to fix');
  } finally { t.rm(); }
});

test('FC drain: a fresh open test gap goes to test-gaps.md as debt/<id>, never to the owner', () => {
  const t = cliRepo('drain-');
  try {
    const debt = F.mergeToDebt('', [{ id: 'F1', severity: 'minor', location: 'a.py:1', file: 'a.py', finding: 'f', if_unfixed: 'u', why_severity: 'm', test: 'none' }], { origin: 's1', parked: '2026-01-01' });
    t.w('runtime/findings/debt.md', debt);
    const rev = r2([['s1/F1', 'minor', 'resolved'], ['F9', 'major', 'open'], ['F10', 'test-gap', 'open']]).replace('s42', 'debt');
    t.w('runtime/findings/debt-r2.md', rev);
    const r = t.run('drain', 'runtime/findings/debt-r2.md');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^new -> needs-owner: F9$/m);
    const owner = t.fs.readFileSync(t.path.join(t.d, 'runtime/findings/needs-owner.md'), 'utf8');
    assert.ok(owner.includes('- drain/F9 · ') && !owner.includes('F10'));
    const gaps = t.fs.readFileSync(t.path.join(t.d, 'runtime/findings/test-gaps.md'), 'utf8');
    assert.ok(gaps.includes('- debt/F10 · app/F10.py:1 · defect F10 · '), gaps);
  } finally { t.rm(); }
});
