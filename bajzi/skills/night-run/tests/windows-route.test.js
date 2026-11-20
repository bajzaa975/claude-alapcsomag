'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const spec = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'bajzi-package-spec.md'), 'utf8');

test('SKILL.md has the Windows route sections and bridge calls', () => {
  for (const s of ['## Windows pane: run through WSL', '## Launcher answers',
    'wsl-bridge.sh" run', 'wsl-bridge.sh launch', 'wsl-bridge.sh check']) {
    assert.ok(skill.includes(s), s);
  }
});

test('Windows PHASE E reads hold.log before the runner check; exit codes 6, 7 and 8 are documented', () => {
  assert.match(skill, /`<NIGHT_DIR>\/logs\/hold\.log`[\s\S]{0,300}BEFORE the step-2 runner check/);
  assert.match(skill, /exit 8 = `launch\.sh` refused|Exit 8 = `launch\.sh` refused/);
  assert.match(skill, /exit 6 = `claude` is not logged in/);
  assert.match(skill, /exit 7 = GitHub cannot see/);
  assert.match(spec, /6 `claude` not logged in in WSL, 7 GitHub cannot see the project repo from WSL, 8 `launch\.sh` refused/);
});

test('launcher answers: mode and who-starts mappings, never re-ask', () => {
  assert.match(skill, /mode: Claude\|Mix\|GLM` -> saver L0\|L2\|L3/);
  assert.ok(skill.includes('`who starts: Claude after my go` -> PHASE E launches on the owner\'s go'));
  assert.ok(skill.includes('`who starts: me, with the Start button` -> PHASE E hands the launch command'));
  assert.ok(skill.includes('NEVER re-ask'));
});

test('never-relabel rule near the PHASE E fallback', () => {
  assert.ok(skill.includes('never run the work in this session and call it a night run'));
});

test('spec has the change-map row and the 6.2 paragraph', () => {
  assert.ok(spec.includes('| Night run from a Windows pane (WSL bridge, holder, launcher answers) |'));
  assert.ok(spec.includes('**Night run from a Windows pane**'));
});
