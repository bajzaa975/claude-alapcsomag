'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && fs.existsSync(path.join(ROOT, f)));

// The corpus is code, manifests, templates and skill/agent .md files; every other .md (READMEs,
// CHANGELOG, CLAUDE.md files, docs/) is excluded, so a key only that prose mentions is reported.
const corpus = files.filter((f) => /\.(md|sh|js|json|tmpl)$/.test(f) && !/\/tests\//.test(f) && !(/\.md$/.test(f) && !/(^|\/)(skills|agents)\//.test(f))).map((f) => read(f)).join('\n');
const missingIn = (readme) => {
  const missing = [];
  for (const [, tok] of readme.matchAll(/`([^`\n]+)`/g)) {
    if (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(tok) && /\.[a-z]+$/.test(tok)) {
      if (/^(runtime|\.claude)\//.test(tok)) continue;
      if (!fs.existsSync(path.join(ROOT, tok)) && !files.some((f) => f.endsWith('/' + tok))) missing.push(tok);
    } else if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(tok) && !corpus.includes(tok)) {
      missing.push(tok);
    }
  }
  return missing;
};

test('README backticked paths and CONFIG_KEYS exist in the tree', () => {
  assert.deepStrictEqual(missingIn(read('README.md')), []);
});

test('the README key check fails on a key absent from the code', () => {
  assert.deepStrictEqual(missingIn('`NO_SUCH_KEY_ZZ`'), ['NO_SUCH_KEY_ZZ']);
});

test('the README key check still reports a key that only excluded prose .md files mention', () => {
  const key = 'NODE_TEST_CONTEXT'; // backticked in docs/bajzi-package-spec.md, absent from code
  assert.ok(read('docs/bajzi-package-spec.md').includes('`' + key + '`'), 'spec no longer names ' + key);
  assert.deepStrictEqual(missingIn('`' + key + '`'), [key]);
});

test('plugin license fields match the license named in LICENSE', () => {
  const norm = (s) => s.toLowerCase().replace(/license/g, '').replace(/[^a-z0-9.]/g, '');
  const want = norm(read('LICENSE').split('\n')[0].replace(/^#\s*/, ''));
  const manifests = files.filter((f) => /(^|\/)(plugin|marketplace)\.json$/.test(f));
  assert.ok(manifests.length > 0);
  for (const m of manifests) {
    const j = JSON.parse(read(m));
    for (const l of [j.license, ...(j.plugins || []).map((p) => p.license)].filter(Boolean)) {
      assert.strictEqual(norm(l), want, m);
    }
  }
});

test('the docs name the handover file as runtime/handoff/<slug>.md and leave the slug to /bajzi:handoff', () => {
  assert.match(read('bajzi/hooks/handoff-load.sh'), /runtime\/handoff\/<slug>\.md/);
  assert.doesNotMatch(read('shared/CLAUDE.md'), /runtime\/HANDOFF\.md/);
  for (const f of ['README.md', 'bajzi/README.md', 'shared/CLAUDE.md']) {
    const s = read(f).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ');
    assert.match(s, /`runtime\/handoff\/<slug>\.md`, where `\/bajzi:handoff` derives `<slug>` from the current branch \(`handoff-load\.sh` resolves the same name\)/, f);
    assert.doesNotMatch(s, /runtime\/handoff\/<(?!slug>)[^>\s]*>\.md/, f);
    assert.doesNotMatch(s.replace(/`[^`]*`/g, ''), /<slug>/, f + ': <slug> outside code formatting');
  }
});

test('README suite command covers every *.test.js', () => {
  const m = read('README.md').match(/^node --test (.+)$/m);
  assert.ok(m, 'suite command');
  const res = m[1].split(/\s+/).map((g) => new RegExp('^' + g.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*') + '$'));
  const uncovered = files.filter((f) => /\.test\.js$/.test(f) && !res.some((r) => r.test(f)));
  assert.deepStrictEqual(uncovered, []);
});

test('bajzi/README.md names every hook script wired in hooks.json', () => {
  const cmds = JSON.stringify(JSON.parse(read('bajzi/hooks/hooks.json')));
  const names = [...new Set([...cmds.matchAll(/hooks\/(?:node\/)?([a-z-]+\.(?:sh|js))/g)].map((x) => x[1]))];
  const readme = read('bajzi/README.md');
  assert.deepStrictEqual(names.filter((n) => !readme.includes(n)), []);
});

// Spec-consistency checks.
const spec = read('docs/bajzi-package-spec.md');
const specLine = (start) => spec.split('\n').find((l) => l.startsWith(start));

test('spec triage row labels tier-0 behaviour that night-watch.sh does not implement as external', () => {
  const row = specLine('| Night-run triage watcher');
  const nw = read('bajzi/skills/night-run/night-watch.sh');
  for (const tok of ['REVIEW DUE: watcher fix commit', 'aborted: baseline RED']) {
    assert.ok(row.includes(tok), tok);
    if (!nw.includes(tok)) assert.match(row, /external/, tok + ' must be attributed to an external runner');
  }
});

test('spec add-on paragraph names no addon-* block and points at SKILL.md "Add-on skills"', () => {
  const para = spec.split('\n').find((l) => l.startsWith('**Night-run add-on skills**'));
  assert.ok(para);
  assert.doesNotMatch(para, /addon-(queue|brief|check|allow)/);
  assert.ok(para.includes('bajzi/skills/night-run/SKILL.md') && para.includes('"Add-on skills"'));
});

test('no spec sentence points at a ~/.claude/CLAUDE.md section the shared rule text lacks', () => {
  const i = spec.indexOf('**Rule id and deny reasons**');
  const block = spec.slice(i, spec.indexOf('**Inbox notice**', i));
  assert.ok(block.length > 50);
  assert.doesNotMatch(block, /CLAUDE.md/);
  assert.doesNotMatch(specLine('**Global rule text**'), /plugin changes/);
  assert.doesNotMatch(spec, /covers intent/);
});

test('every shared/CLAUDE.md section the spec quotes exists in that file', () => {
  const heads = read('shared/CLAUDE.md').split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).toLowerCase());
  const line = specLine('**Global rule text**');
  assert.ok(line.includes('shared/CLAUDE.md'));
  const quoted = [...line.split('shared rule text')[0].matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  assert.ok(quoted.length > 0);
  for (const q of quoted) assert.ok(heads.some((h) => h.startsWith(q)), q);
});

test('spec /bajzi:debt row names the listed nothing-written exit-2 paths of calibrate (update the list when calibrate gains one)', () => {
  const row = specLine('| `/bajzi:debt');
  const i = row.indexOf('[`calibrate`:');
  assert.ok(i >= 0, 'calibrate step');
  const cal = row.slice(i, row.indexOf(']', i));
  for (const re of [/no re-rate file argument/, /missing or invalid `debt\.md`/, /missing re-rate file\b/,
    /(unknown|bad) severity/, /duplicate id/, /`debt\.md` id (missing from|not in) the re-rate file/]) {
    assert.match(cal, re);
  }
  assert.match(cal, /exits 2 with nothing written on [^;]+; otherwise it writes `blind_severity`/);
});

test('the Z.ai peak window is the same in peak.js, cc-router.js and night-run SKILL.md PHASE D', () => {
  const { peakStatus } = require(path.join(ROOT, 'bajzi/hooks/node/lib/peak.js'));
  const m = read('bajzi/bin/cc-router.js').match(/function peakOpen\(now\) \{[^\n]*\}/);
  const peakOpen = new Function('return ' + m[0].replace('function peakOpen', 'function'))();
  const win = read('bajzi/skills/night-run/SKILL.md').match(/overlaps any (\d\d):00-(\d\d):00 UTC window/);
  assert.ok(win, 'SKILL.md PHASE D window');
  const [s, e] = [Number(win[1]), Number(win[2])];
  for (let h = 0; h < 24; h++) for (const mi of [0, 59]) {
    const t = Date.UTC(2026, 0, 1, h, mi);
    const want = h >= s && h < e;
    assert.strictEqual(peakStatus(t).inPeak, want, 'peak.js ' + h + ':' + mi);
    assert.strictEqual(peakOpen(new Date(t)), want, 'cc-router ' + h + ':' + mi);
  }
  const row = specLine('| Z.ai peak window');
  assert.match(row, /peak\.test\.js/);
  assert.match(row, /three/);
});

test('the background-dispatch rule is carried by run.sh, SAVER-RULES.md and SAVER-L1.md', () => {
  assert.match(read('bajzi/skills/night-run/run.sh'), /LAST action depends on runs in the FOREGROUND[\s\S]{0,200}run_in_background/);
  for (const f of ['bajzi/skills/mode/SAVER-RULES.md', 'bajzi/skills/mode/SAVER-L1.md']) {
    assert.match(read(f).replace(/\s+/g, ' '), /EXCEPT in a headless `claude -p` session/, f);
  }
  assert.doesNotMatch(specLine('| Foreground-gate rule'), /mode\.sh/);
});

test('README fail-closed list names exactly the exceptions of spec Invariant 1', () => {
  const m = /(Two|Three|Four) exceptions fail closed: (.*?)\.(?: |$)/.exec(read('README.md').replace(/\s+/g, ' '));
  assert.ok(m, 'no fail-closed list');
  assert.strictEqual(m[1], 'Two');
  assert.match(m[2], /pre-commit gate/);
  assert.match(m[2], /day-run-mode\.sh/);
  assert.doesNotMatch(m[2], /push guard/);
});

test('a README that uses a worker/glm shim also names the shim install step', () => {
  const r = read('README.md');
  if (/^(worker|glm) /m.test(r)) assert.match(r, /\/bin\/install\.sh/);
});

const changelogNamesLicense = (changelog, licenseName) =>
  changelog.split(/\n(?=## )/).slice(1).some((e) => e.includes(licenseName.replace(/^#\s*/, '').trim().replace(/ License/, '')));

test('some CHANGELOG entry names the license LICENSE gives', () => {
  assert.ok(changelogNamesLicense(read('CHANGELOG.md'), read('LICENSE').split('\n')[0]));
});

test('changelogNamesLicense: an older entry naming the license passes, no entry naming it fails', () => {
  const cl = '# Changelog\n\n## 2.0.0\n- fix\n\n## 1.0.0\n- Relicensed under MIT\n';
  assert.ok(changelogNamesLicense(cl, '# MIT License'));
  assert.ok(!changelogNamesLicense('# Changelog\n\n## 2.0.0\n- fix\n', '# MIT License'));
});

test('READMEs describe the 1.19.0 effort, fail-closed pre-tool and setup install changes', () => {
  const r = read('README.md').replace(/\s+/g, ' ');
  const b = read('bajzi/README.md').replace(/\s+/g, ' ');
  for (const s of [r, b]) {
    assert.match(s, /xhigh/);
    assert.match(s, /pacing sentence/);
    assert.match(s, /onFailure: block/);
    assert.match(s, /2\.1\.295/);
  }
  assert.match(r, /claude plugin install <id> --marketplace <source>/);
  assert.match(r, /2\.1\.292/);
});

// Pacing classes come from the PACING line of DAY-RUN-RULES.md, so a README that drifts fails.
const pacing = () => {
  const m = read('bajzi/skills/mode/DAY-RUN-RULES.md').replace(/\s+/g, ' ').match(/PACING: briefs for (.+?) end with:/);
  assert.ok(m, 'PACING line not found');
  return m[1];
};
const pacingDoc = (p) => {
  const m = read(p).replace(/\s+/g, ' ').match(/briefs for (locate\/map[^;.]*?) end with a pacing sentence/i);
  assert.ok(m, p + ' lacks the pacing class list');
  return m[1];
};
test('README.md pacing classes match DAY-RUN-RULES.md', () => {
  assert.strictEqual(pacingDoc('README.md'), pacing());
  assert.match(read('README.md').replace(/\s+/g, ' '), /review, debugging and documents briefs never do/);
});
test('bajzi/README.md pacing classes match DAY-RUN-RULES.md', () => {
  assert.strictEqual(pacingDoc('bajzi/README.md'), pacing());
  assert.match(read('bajzi/README.md').replace(/\s+/g, ' '), /review, debugging and documents briefs never do/);
});
