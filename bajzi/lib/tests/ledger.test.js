'use strict';
// Sprint ledger: FC ledger <stem> | escaped | report. Fixture repo + fixture transcripts (BAJZI_TRANSCRIPTS).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'findings-cli.js');
const STEM = 's1';
const T0 = '2026-11-01T10:00:00Z';
const IN = '2026-11-01T11:00:00Z';
const BASE = '2026-11-01T08:00:00Z';
const EARLY = '2026-11-01T09:00:00Z'; // after the base commit, before the first implement commit

const finding = (id, sev, extra = '', tail = '') => `## ${id} · ${sev} · a.js:1\nfinding: x\nif_unfixed: y\nwhy_severity: z\ntest: none\n${extra}${tail}\n`;
const doc = (slice, round, body) => `# Findings · ${slice} · round ${round}\nrange: a..b\nreviewer: opus\nverdict: FINDINGS 1\nfiles_reviewed: 1\n\n${body}`;

function sh(cwd, args, env = {}) {
  return spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
function line(o) { return JSON.stringify(o); }
function msg(id, model, usage, ts = IN, cwd) {
  return line({ type: 'assistant', timestamp: ts, cwd, message: { id, model, usage, content: [] } });
}

function fixture({ transcripts = true, r2 = true, critic = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-home-'));
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-tr-'));
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
  w('runtime/slices/s1-t1.md', '# s1-t1\n'); w('runtime/slices/s1-t2.md', '# s1-t2\n');
  w('runtime/findings/s1-t1-r1.md', doc('s1-t1', 1,
    finding('F1', 'major', 'class: lifecycle\n') + finding('F2', 'blocker', 'class: other\ncritic: S1\n') + finding('F3', 'major') + finding('F4', 'minor') + finding('F5', 'test-gap')));
  if (r2) {
    w('runtime/findings/s1-t1-r2.md', doc('s1-t1', 2,
      finding('F1', 'major', '', 'status: resolved\n') + finding('F6', 'major', '', 'status: open\n') + finding('F7', 'major', 'critic: S1\n', 'status: resolved\n')));
  }
  w('runtime/findings/s1-t2-r1.md', doc('s1-t2', 1, finding('F1', 'major', 'class: lifecycle\n')));
  if (critic) {
    w('runtime/critic/s1.md', ['# Critic', 'model: fable', '',
      '## S1 · s1-t1 · high', 'trigger: a', 'breaks: b', 'test: c', '',
      '## S2 · s1-t2 · low', 'trigger: a', 'breaks: b', 'test: c', '',
      '## S3 · s1-t2 · medium', 'trigger: a', 'breaks: b', 'test: c', '',
      '## Triage', 'S1: accept', 'S2: reject', 'S3: accept', ''].join('\n'));
  }
  if (critic) { const m = new Date('2026-11-01T08:30:00Z'); fs.utimesSync(path.join(repo, 'runtime/critic/s1.md'), m, m); }
  sh(repo, ['git', 'init', '-q']);
  const cenv = (d) => ({ GIT_COMMITTER_DATE: d, GIT_AUTHOR_DATE: d, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  fs.writeFileSync(path.join(repo, '.keep'), '');
  sh(repo, ['git', 'add', '.keep']);
  sh(repo, ['git', 'commit', '-q', '-m', 'base'], cenv(BASE));
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-q', '-m', 's1-t1: implement'], cenv(T0));
  if (transcripts) {
    const p = path.join(tdir, 'proj');
    fs.mkdirSync(path.join(p, 'sess', 'subagents'), { recursive: true });
    const u = (i, o, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
    const main = [
      msg('m1', 'claude-fable-5-2', u(1000000, 0), IN, repo),
      msg('m1', 'claude-fable-5-2', u(1000000, 0), IN, repo), // duplicate content block, same message.id
      msg('mx', 'claude-fable-5-2', u(1000000, 0), IN, '/some/other/repo'), // other repo: not counted
      msg('mo', 'claude-fable-5-2', u(1000000, 0), '2026-10-01T00:00:00Z', repo), // before the window: not counted
    ];
    fs.writeFileSync(path.join(p, 'sess.jsonl'), main.join('\n') + '\n');
    const sub = (name, type, lines) => {
      fs.writeFileSync(path.join(p, 'sess', 'subagents', `${name}.jsonl`), lines.join('\n') + '\n');
      fs.writeFileSync(path.join(p, 'sess', 'subagents', `${name}.meta.json`), JSON.stringify({ agentType: type }));
    };
    sub('agent-a', 'bajzi:implementer', [msg('a1', 'claude-sonnet-5-5', u(1000000, 100000), IN, repo)]);
    sub('agent-b', 'bajzi:reviewer', [msg('b1', 'claude-haiku-5-5', u(1000, 1000), IN, repo)]);
    sub('agent-c', 'bajzi:plan-critic', [msg('c1', 'claude-opus-5-5', u(0, 0, 1000000, 0), IN, repo)]);
  }
  return { repo, home, tdir, env: { BAJZI_TRANSCRIPTS: tdir, HOME: home, USERPROFILE: home } };
}
const ledger = (f, ...a) => sh(f.repo, ['node', CLI, 'ledger', ...a], f.env);
const lines = (f) => fs.readFileSync(path.join(f.repo, 'runtime', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('ledger <stem>: per-slice findings counts, rounds, critic', () => {
  const f = fixture();
  const r = ledger(f, STEM);
  assert.strictEqual(r.status, 0, r.stderr);
  const [row] = lines(f);
  const t1 = row.slices.find((s) => s.id === 's1-t1');
  assert.deepStrictEqual(t1.r1, { lifecycle: 1, other: 2 }); // F3 has no class -> other; minor and test-gap not counted
  assert.strictEqual(t1.r2_new_majors, 2); // F6, F7 (F1 is a round-1 id)
  assert.strictEqual(t1.open_after_r2, 1);
  assert.strictEqual(t1.rounds, 2);
  const t2 = row.slices.find((s) => s.id === 's1-t2');
  assert.strictEqual(t2.rounds, 1);
  assert.strictEqual(t2.r2_new_majors, 0);
  assert.deepStrictEqual(row.critic, { raised: 3, accepted: 2, matched: 1, skipped: false });
});

test('usage: dedupe by message.id, window and repo filter, exact cost by agent type, plan approx', () => {
  const f = fixture();
  ledger(f, STEM);
  const [row] = lines(f);
  assert.strictEqual(row.cost.agents['bajzi:implementer'].usd, 3); // 1M in at $2 + 100k out at $10
  assert.strictEqual(row.cost.agents['bajzi:plan-critic'].usd, 0.2); // 1M cache read, opus 0.05x of $4
  assert.strictEqual(row.cost.agents.main.usd, 8); // m1 counted once
  assert.strictEqual(row.cost.phases.plan.approx, true);
  assert.strictEqual(row.cost.phases.build.approx, undefined);
  assert.strictEqual(row.cost.phases.build.usd, 3);
  assert.strictEqual(row.cost.phases.critic.usd, 0.2);
});

test('a model missing from prices.json costs null and prints n/a', () => {
  const f = fixture();
  ledger(f, STEM);
  const [row] = lines(f);
  assert.strictEqual(row.cost.agents['bajzi:reviewer'].usd, null);
  assert.strictEqual(row.cost.phases.review.usd, null);
  const rep = ledger(f, 'report').stdout;
  assert.match(rep, /review n\/a/);
});

test('repeat send replaces the stem line; other lines stay', () => {
  const f = fixture();
  ledger(f, STEM);
  ledger(f, 'escaped', STEM, 'a bug got out');
  ledger(f, STEM);
  const rows = lines(f);
  assert.strictEqual(rows.filter((r) => r.type === 'sprint' && r.stem === STEM).length, 1);
  const esc = rows.filter((r) => r.type === 'escaped');
  assert.strictEqual(esc.length, 1);
  assert.strictEqual(esc[0].text, 'a bug got out');
});

test('no r2 files, no critic, no transcripts: zeros, note, line written, savings n/a', () => {
  const f = fixture({ transcripts: false, r2: false, critic: false });
  const r = ledger(f, STEM);
  assert.strictEqual(r.status, 0, r.stderr);
  const [row] = lines(f);
  assert.strictEqual(row.slices[0].r2_new_majors, 0);
  assert.strictEqual(row.slices[0].open_after_r2, 0);
  assert.deepStrictEqual(row.critic, { raised: 0, accepted: 0, matched: 0, skipped: false });
  assert.match(row.note, /no transcripts/);
  assert.strictEqual(row.cost.phases.plan.usd, 0);
  const rep = ledger(f, 'report');
  assert.strictEqual(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /savings: n\/a/);
});

test('critic skipped line shows in the row', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'runtime/critic/s1.md'), '# Critic\n\n## Triage\nskipped: tiny plan\n');
  ledger(f, STEM);
  assert.strictEqual(lines(f)[0].critic.skipped, true);
});

function baselineSetup(f, withDefault) {
  const base = path.join(f.home, 'baselines.json');
  const row = { r1_majors_per_slice: 2, rounds_per_slice: 2, round_cost_usd: 10 };
  const body = { default: { ...row, rounds_per_slice: 3 } };
  if (withDefault !== 'default-only') body[path.basename(f.repo)] = row;
  fs.writeFileSync(base, JSON.stringify(body));
  fs.mkdirSync(path.join(f.home, '.claude', 'bajzi'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude', 'bajzi', 'config.json'), JSON.stringify({ ledger_baselines: base }));
}

test('report: raw rows before savings (estimate); repo row used', () => {
  const f = fixture();
  ledger(f, STEM);
  baselineSetup(f);
  const out = ledger(f, 'report').stdout;
  assert.ok(out.indexOf('rounds/slice') >= 0 && out.indexOf('rounds/slice') < out.indexOf('savings (estimate)'));
  assert.match(out, /plan \$8\.00 approx/);
  // actual rounds/slice = (2+1)/2 = 1.5; (2 - 1.5) x 2 slices x $10 = $10.00
  assert.match(out, /savings \(estimate\): \$10\.00/);
});

test('report: unknown repo falls back to the default row', () => {
  const f = fixture();
  ledger(f, STEM);
  baselineSetup(f, 'default-only');
  // default rounds 3: (3 - 1.5) x 2 x 10 = 30
  assert.match(ledger(f, 'report').stdout, /savings \(estimate\): \$30\.00/);
});

test('report: no ledger_baselines key -> savings: n/a', () => {
  const f = fixture();
  ledger(f, STEM);
  assert.match(ledger(f, 'report').stdout, /savings: n\/a/);
});

test('prices.json carries as_of and no model without a documented price', () => {
  const p = require('../prices.json');
  assert.match(p.as_of, /^\d{4}-\d{2}-\d{2}$/);
  for (const [m, v] of Object.entries(p.models)) {
    assert.ok(v.input > 0 && v.output > 0 && v.cache_write_mult > 0 && v.cache_read_mult > 0, m);
  }
});

test('ledger: a sprint reviewed under the stem name (<stem>-r1.md, -r2.md) fills the slice rows', () => {
  const f = fixture({ r2: false });
  for (const n of ['s1-t1-r1', 's1-t2-r1']) fs.rmSync(path.join(f.repo, 'runtime/findings', `${n}.md`));
  const w = (n, c) => fs.writeFileSync(path.join(f.repo, 'runtime/findings', `${n}.md`), c);
  w('s1-r1', doc('s1', 1, finding('F1', 'major', 'class: lifecycle\n') + finding('F2', 'blocker', 'critic: S1\n')));
  w('s1-r2', doc('s1', 2, finding('F1', 'major', '', 'status: resolved\n') + finding('F3', 'major', '', 'status: open\n')));
  assert.strictEqual(ledger(f, STEM).status, 0);
  const [row] = lines(f);
  const sum = (k) => row.slices.reduce((t, s) => t + (typeof k === 'function' ? k(s) : s[k]), 0);
  assert.strictEqual(sum((s) => s.r1.lifecycle), 1);
  assert.strictEqual(sum((s) => s.r1.other), 1);
  assert.strictEqual(sum('r2_new_majors'), 1);
  assert.strictEqual(sum('open_after_r2'), 1);
  assert.ok(row.slices.every((s) => s.rounds === 2));
  assert.strictEqual(row.critic.matched, 1);
});

test('usage: the critic and the first implementer run before the first implement commit are costed', () => {
  const f = fixture();
  const sd = path.join(f.tdir, 'proj', 'sess', 'subagents');
  const u = (i, o, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 });
  const sub = (name, type, m) => {
    fs.writeFileSync(path.join(sd, `${name}.jsonl`), m + '\n');
    fs.writeFileSync(path.join(sd, `${name}.meta.json`), JSON.stringify({ agentType: type }));
  };
  sub('agent-e1', 'bajzi:plan-critic', msg('e1', 'claude-opus-5-5', u(0, 0, 1000000), EARLY, f.repo));
  sub('agent-e2', 'bajzi:implementer', msg('e2', 'claude-sonnet-5-5', u(1000000, 0), EARLY, f.repo));
  ledger(f, STEM);
  const [row] = lines(f);
  assert.strictEqual(row.cost.phases.critic.usd, 0.4); // 0.2 in the window as before + 0.2 early
  assert.strictEqual(row.cost.phases.build.usd, 5); // 3 + 1M in at $2
});

test('usage: work before the plan/critic file existed is excluded; no plan/critic file falls back to the parent commit', () => {
  const PRE = '2026-11-01T08:15:00Z'; // after the base commit, before the critic file (08:30)
  const add = (f) => {
    const sd = path.join(f.tdir, 'proj', 'sess', 'subagents');
    const u = (i) => ({ input_tokens: i, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const sub = (name, type, m) => {
      fs.writeFileSync(path.join(sd, `${name}.jsonl`), m + '\n');
      fs.writeFileSync(path.join(sd, `${name}.meta.json`), JSON.stringify({ agentType: type }));
    };
    sub('agent-p1', 'bajzi:implementer', msg('p1', 'claude-sonnet-5-5', u(1000000), PRE, f.repo));
    sub('agent-p2', 'bajzi:reviewer', msg('p2', 'claude-sonnet-5-5', u(1000000), PRE, f.repo));
  };
  const f = fixture(); add(f);
  ledger(f, STEM);
  let [row] = lines(f);
  assert.strictEqual(row.cost.phases.build.usd, 3); // previous sprint's implementer not counted
  assert.strictEqual(row.cost.phases.review.usd, null); // only the haiku run (no price); p2 not counted
  const g = fixture({ critic: false }); add(g);
  ledger(g, STEM);
  [row] = lines(g);
  assert.strictEqual(row.cost.phases.build.usd, 5); // no plan/critic file: parent commit (08:00) opens the window
});

test('ledger: a BOM line is kept; an unparseable line refuses (exit 2) and nothing is rewritten', () => {
  const f = fixture();
  const file = path.join(f.repo, 'runtime', 'ledger.jsonl');
  const good = JSON.stringify({ type: 'escaped', stem: 'x', text: 'a', ts: 'now' });
  fs.writeFileSync(file, `\uFEFF${good}\n`);
  assert.strictEqual(ledger(f, 'escaped', STEM, 'b').status, 0);
  assert.strictEqual(lines(f).length, 2);
  const bad = `${good}\n${good},\n`;
  fs.writeFileSync(file, bad);
  const r = ledger(f, 'escaped', STEM, 'c');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), bad);
});
