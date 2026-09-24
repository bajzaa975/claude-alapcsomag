'use strict';
// T2 (agents-and-cadence plan, §4.2): findings-file format, parser and close policy (D4-D6).
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
  const open = rows.filter((r) => r[2] !== 'resolved').length;
  let s = `# Findings · s42 · round 2\nrange: abc1234..0123abc\nreviewer: opus\n` +
    `verdict: ${open ? `FINDINGS ${open}` : 'CLEAN'}\nfiles_reviewed: 2\n`;
  for (const [id, sev, status, loc] of rows) {
    s += `\n## ${id} · ${sev} · ${loc || `app/${id}.py:1`}\nfinding: defect ${id}\n` +
      `if_unfixed: users see ${id}\nwhy_severity: rubric ${sev}\ntest: none\nstatus: ${status}\n`;
  }
  return s;
}

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
  const r = F.applyClosePolicy(r2([['F1', 'blocker', 'resolved'], ['F2', 'nit', 'resolved']]), 'FIX s42 DONE 2/2');
  assert.deepStrictEqual(byId(r.resolved), ['F1', 'F2']);
  assert.deepStrictEqual([r.owner, r.debt], [[], []]);
});

test('D4: open blocker OUT_OF_SLICE -> owner, severity unchanged', () => {
  const r = F.applyClosePolicy(r2([['F1', 'blocker', 'open']]), 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity, x.original_severity]), [['F1', 'blocker', 'blocker']]);
  assert.deepStrictEqual(r.debt, []);
});

test('D4: open major OUT_OF_SLICE -> owner, severity unchanged', () => {
  const r = F.applyClosePolicy(r2([['F1', 'major', 'open']]), 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity]), [['F1', 'major']]);
});

test('D4: open minor OUT_OF_SLICE -> debt', () => {
  const r = F.applyClosePolicy(r2([['F1', 'minor', 'open']]), 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual([byId(r.debt), r.owner], [['F1'], []]);
});

test('D4: open nit OUT_OF_SLICE -> debt', () => {
  const r = F.applyClosePolicy(r2([['F1', 'nit', 'open']]), 'FIX s42 DONE 0/1\nF1 OUT_OF_SLICE');
  assert.deepStrictEqual([byId(r.debt), r.owner], [['F1'], []]);
});

for (const [from, to] of [['nit', 'minor'], ['minor', 'major'], ['major', 'blocker'], ['blocker', 'blocker']]) {
  test(`D4: open ${from} ATTEMPTED -> escalated to ${to} -> owner, with the reason`, () => {
    const r = F.applyClosePolicy(r2([['F1', from, 'open']]), 'FIX s42 DONE 0/1\nF1 ATTEMPTED: needs a schema change');
    assert.deepStrictEqual(r.debt, []);
    assert.strictEqual(r.owner.length, 1);
    const o = r.owner[0];
    assert.deepStrictEqual([o.severity, o.original_severity], [to, from]);
    assert.strictEqual(o.if_unfixed, 'users see F1');
    assert.match(o.reason, /needs a schema change/);
  });
}

test('D4: open with no fixer mark (fixer claimed fixed) counts as attempted -> escalated -> owner', () => {
  const r = F.applyClosePolicy(r2([['F1', 'minor', 'open']]), 'FIX s42 DONE 1/1');
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity]), [['F1', 'major']]);
  assert.deepStrictEqual(r.debt, []);
});

test('D4: new round-2 finding (absent from round 1) is not attempted: minor -> debt, major -> owner unescalated', () => {
  const round2 = r2([['F1', 'blocker', 'resolved'], ['F2', 'minor', 'open'], ['F3', 'minor', 'open'], ['F4', 'major', 'open']]);
  const round1 = r2([['F1', 'blocker', 'open'], ['F2', 'minor', 'open']]).replace('round 2', 'round 1').replace(/^status: .*\n/gm, '');
  const r = F.applyClosePolicy(round2, 'FIX s42 DONE 1/2', round1);
  assert.deepStrictEqual(byId(r.debt), ['F3']);
  assert.deepStrictEqual(r.owner.map((x) => [x.id, x.severity]).sort(), [['F2', 'major'], ['F4', 'major']]);
});

test('D4: fixer report accepts ids listed with leading bullets/spaces', () => {
  const r = F.applyClosePolicy(r2([['F1', 'nit', 'open']]), 'FIX s42 DONE 0/1\n  - F1 OUT_OF_SLICE');
  assert.deepStrictEqual(byId(r.debt), ['F1']);
});

test('applyClosePolicy refuses a round-1 file and an invalid file', () => {
  assert.throws(() => F.applyClosePolicy(R1, 'FIX s42 DONE 2/2'), /round 2/);
  assert.throws(() => F.applyClosePolicy(r2([['F1', 'nit', 'open']]).replace(/^test: .*\n/m, ''), ''), /test/);
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
