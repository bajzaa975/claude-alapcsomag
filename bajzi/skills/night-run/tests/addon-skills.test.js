'use strict';
// The night run hard-wires no external memory or journal tool: anything project-specific beyond
// docs/NIGHT-RULES.md reaches it only through the ADDON_SKILLS contract (SKILL.md "Add-on skills").
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8').replace(/\r\n/g, '\n');
const NAME = ['BACK', 'LOG.md'].join(''); // built from fragments so this file never names it
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// The banned names are built from parts, so this file passes its own scan.
const BANNED = [new RegExp('\\b' + 'bra' + 'in\\b', 'i'), new RegExp('update' + '-monitor'),
  new RegExp('run' + 'book list', 'i'), new RegExp('~/' + 'infra\\b'), new RegExp('~/' + 'night/')];

test('no file in the skill names the external memory CLI, the journal tool, the owner\'s private runbook or the infra/legacy night trees', () => {
  const hits = [];
  for (const f of walk(DIR)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      for (const re of BANNED) if (re.test(l)) hits.push(`${path.relative(DIR, f)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

test('config.env.tmpl declares ADDON_SKILLS as optional, empty by default', () => {
  const c = read('templates', 'config.env.tmpl');
  assert.match(c, /^# Optional \(default: none\)\.[^\n]*\n(?:#[^\n]*\n)*?ADDON_SKILLS=""$/m);
});

test('BRIEF.md.tmpl carries {{ADDON_RULES}} once and documents it in its placeholder list', () => {
  const b = read('templates', 'BRIEF.md.tmpl');
  const doc = b.slice(0, b.indexOf('-->'));
  assert.strictEqual(b.split('{{ADDON_RULES}}').length - 1, 1);
  assert.match(doc, /^ {4}ADDON_RULES {2,}\S/m);
  assert.ok(b.indexOf('{{ADDON_RULES}}') > b.indexOf('## 6. Project rules'), 'after section 6');
  assert.ok(b.indexOf('{{ADDON_RULES}}') < b.indexOf('## 7. Model policy'), 'before section 7');
});

test('SKILL.md documents the add-on contract and all four block info strings', () => {
  const s = read('SKILL.md');
  const a = s.indexOf('## Add-on skills');
  assert.ok(a >= 0, 'Add-on skills section');
  const sec = s.slice(a, s.indexOf('\n## ', a + 1));
  for (const k of ['addon-check', 'addon-queue', 'addon-brief', 'addon-allow']) assert.ok(sec.includes('`' + k + '`'), k);
  assert.ok(sec.includes('ADDON_SKILLS') && sec.includes('{{ADDON_RULES}}'), 'key and placeholder');
});

// The contract's rules, by phrase on flattened text (planning-rules.test.js style).
const flat = (s) => s.replace(/\s+/g, ' ');
const SKILL = flat(read('SKILL.md'));
const has = (hay, phrase) => assert.ok(hay.includes(phrase), `missing: ${phrase}`);
const slice = (hay, from, to) => {
  const a = hay.indexOf(from), b = hay.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} .. ${to} present in order`);
  return hay.slice(a, b);
};
const ADDON = slice(SKILL, '## Add-on skills', '## PHASE A — Preflight');

test('PHASE A: a missing add-on is a BLOCKER, a failing add-on check is the third STOP', () => {
  const a = slice(SKILL, '## PHASE A — Preflight', '### `status` mode');
  has(a, 'Exactly three findings STOP the skill on the spot');
  has(a, 'a missing `docs/NIGHT-RULES.md` (step 6) and a failing add-on check (step 9)');
  const s9 = slice(SKILL, '9. **Add-on skills.**', '### `status` mode');
  has(s9, 'Not installed → BLOCKER `add-on <name> not installed`');
  has(s9, 'the first that exits non-zero STOPs the skill');
});

test('PHASE A step 9 writes addon-checks.txt and addon-allow.txt afresh; run.sh --smoke embeds the checks', () => {
  const s9 = slice(SKILL, '9. **Add-on skills.**', '### `status` mode');
  has(s9, 'empty `<NIGHT_DIR>/addon-checks.txt` and `<NIGHT_DIR>/addon-allow.txt`');
  has(s9, 'a file an earlier plan wrote must never reach tonight');
  has(ADDON, '`run.sh --smoke` runs every one of them after its git command');
  has(read('run.sh'), '"$NIGHT_DIR/addon-checks.txt"');
});

test('PHASE B: add-on queues first; `# exclusive` makes them the only source of new stories', () => {
  const b = slice(SKILL, '## PHASE B — Collect', '## PHASE C — Plan');
  assert.ok(b.indexOf('1. The add-on queues') >= 0, 'add-on queues are source 1');
  assert.ok(!SKILL.includes(NAME) && !read('templates/BRIEF.md.tmpl').includes(NAME));
  has(b, 'run FIRST, in `ADDON_SKILLS` order');
  has(ADDON, 'A block whose first line is `# exclusive`');
  has(b, 'An `addon-queue` block whose first line is `# exclusive` makes the add-on queues the ONLY source of candidate new stories');
  has(b, 'open PRs (source 3, FOLLOW-UP) and parked retries (source 4) still come in');
});

test('PHASE C: "(no add-on rules)" when empty; add-on allows only appended, after the docker step', () => {
  const c = slice(SKILL, '## PHASE C — Plan', '## PHASE D — Approval gate');
  has(c, '`{{ADDON_RULES}}` is the body of every `addon-brief` block');
  has(c, 'exactly `(no add-on rules)` when there is none');
  has(c, 'They go into `permissions.allow` only and never remove, edit or reorder a deny');
  has(c, 'appends every rule of `<NIGHT_DIR>/addon-allow.txt` (PHASE A step 9) to `permissions.allow` LAST, after its docker step');
  has(c, 'print("ADDON ALLOW TOO WIDE:", r)');
  has(ADDON, 'It refuses an add-on rule with `ADDON ALLOW TOO WIDE: <rule>` in these shapes only');
});

// The guarantee is stated the same way wherever it is stated, and nothing claims more than the check does.
const GUARANTEE = ['deny always beats an add-on allow',
  'the rules check refuses only the listed shapes and cannot judge how wide a rule is in general',
  'therefore PHASE D shows every add-on rule verbatim and the user decides'];
test('add-on allow guarantee: a deny wins, only the listed shapes are refused, PHASE D shows every rule; no wider claim', () => {
  const c = slice(SKILL, '`<addon-allow: ...>` (the last `allow` line)', 'Then run the post-render step');
  const msgs = slice(SKILL, 'The fifth reads `<NIGHT_DIR>/addon-allow.txt`', '**The check is scoped to the RULES');
  for (const [name, hay] of [['Add-on skills', ADDON], ['PHASE C settings bullet', c], ['rules-check message list', msgs]]) {
    for (const p of GUARANTEE) assert.ok(hay.includes(p), `${name} missing: ${p}`);
  }
  assert.doesNotMatch(SKILL, /approves? a whole tool/);
  for (const shape of ['`Edit(//**)`', '`Edit(~/**)`', '`Edit(./**)`', '`mcp__srv`', '`mcp__srv__*`']) has(ADDON, shape);
});

test('PHASE D: the rules-check line names every ADDON ALLOW message and lists the add-on rules read from addon-allow.txt', () => {
  const d = slice(SKILL, '## PHASE D — Approval gate', '## PHASE E — Launch');
  has(d, 'no `ADDON ALLOW FILE MISSING:`, no `ADDON ALLOW MISSING:` and no `ADDON ALLOW TOO WIDE:`');
  has(d, 'list every add-on allow rule read from `<NIGHT_DIR>/addon-allow.txt` (each one proved present in `permissions.allow` by the rules check), verbatim, or say "no add-on allow rules"');
  assert.ok(!d.includes('appended from an `addon-allow` block'), 'PHASE D lists from the file, not from the blocks');
});

test('run.sh report prompt: "change nothing else" names the End of night: items as its exception', () => {
  const run = read('run.sh');
  has(run, "change nothing else, except what the 'End of night:' items of section 6a of $BRIEF ask for");
  assert.ok(!run.includes('Read these with Bash, change nothing else:'), 'no unqualified "change nothing else"');
});

test('End of night: and Supervisor: add-on items reach the report session and the supervisor', () => {
  has(ADDON, 'Lines or subsections labelled `End of night:`');
  has(ADDON, 'those labelled `Supervisor:`');
  const run = read('run.sh');
  has(run, "Then read section 6a (add-on rules) of $BRIEF and carry out its 'End of night:' items, if any.");
  has(run, '8) what the add-on rules say comes next, if any.');
  has(flat(read('templates', 'SUPERVISE-PROMPT.md.tmpl')),
    'read section 6a (add-on rules) of `{{NIGHT_DIR}}/BRIEF.md` and carry out its `Supervisor:` items, if any');
  has(flat(read('templates', 'BRIEF.md.tmpl')), 'Items labelled `End of night:` or `Supervisor:` are not yours');
});
