#!/usr/bin/env node
'use strict';
// The deterministic half of /bajzi:implement|review|fix|debt (agents-and-cadence plan §4.3).
// The skills tell the model WHEN to call this; every routing, cap and round decision is made
// here, on files, so it is testable without a model (bajzi/skills/mode/tests/mode.sh case 16).
// Paths are relative to the cwd (the target repo). Exit codes: 0 ok, 1 refused/cap hit,
// 2 usage or invalid input, 3 STOP (round cap).
//
//   slice <id>                     runtime/slices/<id>.md -> the agent to dispatch
//   validate <findings-file>       verdict + counts by severity; name must match slice/round
//   copy fixer <findings|debt>     writes <file>.fixer.md; a round-2 file -> STOP (exit 3)
//   copy blind                     writes debt.blind.md (severity-stripped, D7)
//   close <slice>                  D4 on r1 + r2 + r1.report.md -> debt.md / needs-owner.md, then D6
//   check                          D6 debt cap: exit 1 on hit
//   drain <review-file>            drops resolved debt entries, new ones -> needs-owner.md
//   calibrate <rerate-file>        writes blind_severity; only disagreements -> needs-owner.md
//   log <class> <subagent> <brief-file> <allow|deny>   one R4 TSV line to runtime/dispatch-sizes.log

const fs = require('fs');
const path = require('path');
const F = require('./findings');

const DIR = 'runtime/findings';
const at = (name) => path.join(DIR, name);
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const today = () => new Date().toISOString().slice(0, 10);

function die(code, msg) { process.stderr.write(`${msg}\n`); process.exit(code); }
function mustRead(p) { if (!fs.existsSync(p)) die(2, `missing file: ${p}`); return read(p); }
function mustParse(text, what) {
  const v = F.validate(text);
  if (!v.ok) die(2, `invalid ${what}: ${v.errors.join('; ')}`);
  return v.doc;
}

// needs-owner.md: one line per decision, appended; an identical line is never added twice.
function toOwner(lines) {
  if (!lines.length) return 0;
  const p = at('needs-owner.md');
  let text = read(p) || '# Needs owner\n\n';
  let n = 0;
  for (const l of lines) {
    if (text.split(/\r?\n/).includes(l)) continue;
    text += `${l}\n`;
    n++;
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(p, text);
  return n;
}
const ownerLine = (id, f, rating, tail) => `- ${id} · ${f.location} · ${rating} · ${f.if_unfixed} · ${tail} · your call`;

function writeDebt(findings) {
  // mergeToDebt keeps each entry's own origin/parked (ids already carry "<origin>/").
  const text = F.mergeToDebt('', findings, { origin: 'debt', parked: today() });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(at('debt.md'), text);
}

const cmds = {
  slice(id) {
    if (!id) die(2, 'usage: slice <id>');
    const p = path.join('runtime/slices', `${id}.md`);
    const lines = mustRead(p).split(/\r?\n/);
    if ((lines.find((l) => l.trim()) || '').trim() !== `# Slice · ${id}`) die(2, `${p}: title must be "# Slice · ${id}"`);
    const s = {};
    for (const l of lines) { const m = l.match(/^(tier|files|acceptance|test):[ \t]*(.*)$/); if (m) s[m[1]] = m[2].trim(); }
    for (const k of ['tier', 'files', 'acceptance', 'test']) if (!s[k]) die(2, `${p}: missing field: ${k}`);
    if (!['1', '2', '3'].includes(s.tier)) die(2, `${p}: tier must be 1, 2 or 3, got ${s.tier}`);
    console.log(`agent: bajzi:${s.tier === '1' ? 'implementer-risk' : 'implementer'}\ntier: ${s.tier}\nfiles: ${s.files}\ntest: ${s.test}`);
  },

  validate(file) {
    if (!file) die(2, 'usage: validate <findings-file>');
    const m = path.basename(file).match(/^(.+)-r(\d+)\.md$/);
    if (m && Number(m[2]) > 2) die(3, `STOP: round ${m[2]} is not a skill round; round 3 is the owner's call`);
    const doc = mustParse(mustRead(file), file);
    if (doc.kind !== 'findings') die(2, `${file}: not a findings file`);
    if (!m || m[1] !== doc.slice || Number(m[2]) !== doc.round) die(2, `${file}: name must be ${doc.slice}-r${doc.round}.md`);
    const open = doc.findings.filter((f) => f.status !== 'resolved');
    const counts = F.SEVERITIES.slice().reverse().map((s) => `${s} ${open.filter((f) => f.severity === s).length}`);
    console.log(`${doc.header.verdict} · ${counts.join(' · ')}`);
  },

  copy(kind, file) {
    if (kind === 'blind') {
      fs.writeFileSync(at('debt.blind.md'), F.stripSeverity(mustRead(at('debt.md'))));
      return console.log(at('debt.blind.md'));
    }
    if (kind !== 'fixer' || !file) die(2, 'usage: copy fixer <findings-file> | copy blind');
    const doc = mustParse(mustRead(file), file);
    if (doc.kind === 'findings' && doc.round === 2) {
      die(3, 'STOP: round 2 was the last skill round; what is open is routed by close. Round 3 is the owner\'s call.');
    }
    if (!doc.findings.length) return console.log('CLEAN: nothing to fix');
    const out = file.replace(/\.md$/, '.fixer.md');
    fs.writeFileSync(out, F.stripForFixer(read(file)));
    console.log(out);
  },

  close(slice) {
    if (!slice) die(2, 'usage: close <slice>');
    const r1 = mustRead(at(`${slice}-r1.md`));
    const r2 = mustRead(at(`${slice}-r2.md`));
    const report = mustRead(at(`${slice}-r1.report.md`));
    let res;
    try { res = F.applyClosePolicy(r2, report, r1); } catch (e) { die(2, e.message); }
    let debtText;
    try { debtText = F.mergeToDebt(read(at('debt.md')), res.debt, { origin: slice, parked: today() }); } catch (e) { die(1, e.message); }
    fs.writeFileSync(at('debt.md'), debtText);
    const owner = res.owner.map((f) => ownerLine(`${slice}/${f.id}`, f,
      f.severity === f.original_severity ? f.severity : `${f.severity} (was ${f.original_severity})`, f.reason));
    toOwner(owner);
    console.log(`closed ${res.resolved.length} · owner ${res.owner.length} · debt ${res.debt.length}`);
    const cap = F.debtCapHit(debtText);
    if (cap.hit) console.log(`DEBT CAP HIT: ${cap.reasons.join('; ')}`);
  },

  check() {
    const cap = F.debtCapHit(read(at('debt.md')));
    if (cap.hit) die(1, `DEBT CAP HIT: ${cap.reasons.join('; ')}`);
    console.log(`debt ok: ${cap.total} items`);
  },

  drain(file) {
    if (!file) die(2, 'usage: drain <review-file>');
    const debt = mustParse(mustRead(at('debt.md')), 'debt.md');
    const rev = mustParse(mustRead(file), file);
    if (rev.kind !== 'findings' || rev.round !== 2) die(2, `${file}: the drain review must be a round 2 file`);
    const status = new Map(rev.findings.map((f) => [f.id, f]));
    const remain = debt.findings.filter((f) => !(status.get(f.id) && status.get(f.id).status === 'resolved'));
    const known = new Set(debt.findings.map((f) => f.id));
    const fresh = rev.findings.filter((f) => !known.has(f.id) && f.status === 'open');
    writeDebt(remain);
    toOwner(fresh.map((f) => ownerLine(`drain/${f.id}`, f, f.severity, 'new in the drain review (introduced by the drain fix)')));
    console.log(`drained ${debt.findings.length - remain.length}, remain ${remain.length}`);
    for (const f of remain) console.log(`- ${f.id}: ${f.if_unfixed}`);
    if (fresh.length) console.log(`new -> needs-owner: ${fresh.map((f) => f.id).join(', ')}`);
  },

  calibrate(file) {
    if (!file) die(2, 'usage: calibrate <rerate-file>');
    const debt = mustParse(mustRead(at('debt.md')), 'debt.md');
    const blind = new Map();
    for (const l of mustRead(file).split(/\r?\n/)) {
      const m = l.match(/^\s*(\S+)\s+·\s+(\S+)\s+·/);
      if (!m) continue;
      if (!F.SEVERITIES.includes(m[2])) die(2, `${file}: ${m[1]}: bad severity: ${m[2]}`);
      blind.set(m[1], m[2]);
    }
    const missing = debt.findings.filter((f) => !blind.has(f.id)).map((f) => f.id);
    if (missing.length) die(2, `${file}: not re-rated: ${missing.join(', ')} (nothing written)`);
    const lines = [];
    for (const f of debt.findings) {
      f.blind_severity = blind.get(f.id);
      if (f.blind_severity !== f.severity) lines.push(ownerLine(f.id, f, `original: ${f.severity} · blind: ${f.blind_severity}`, 'blind re-rate'));
    }
    writeDebt(debt.findings);
    toOwner(lines);
    console.log(`calibrated ${debt.findings.length} · disagreements ${lines.length}`);
  },

  log(cls, sub, brief, decision) {
    if (!cls || !sub || !brief || !/^(allow|deny)$/.test(decision || '')) die(2, 'usage: log <class> <subagent> <brief-file> <allow|deny>');
    const chars = Array.from(mustRead(brief)).length;
    fs.mkdirSync('runtime', { recursive: true });
    const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    fs.appendFileSync('runtime/dispatch-sizes.log', `${iso}\tSKILL-${cls.toUpperCase()}\t${sub}\t${chars}\t${decision}\n`);
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) die(2, `usage: findings-cli.js <${Object.keys(cmds).join('|')}> ...`);
cmds[cmd](...args);
