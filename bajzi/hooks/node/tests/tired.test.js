'use strict';
// tired.js (SessionStart): `compact` + the session's .tired file -> the tired Rules as context; any other
// source deletes the file and prints nothing. Fail-open.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { NODE_DIR, runScript, tmpDir } = require('./helpers');
const SCRIPT = path.join(NODE_DIR, 'tired.js');
const go = (input, mark = true) => {
  const dir = tmpDir('tired-');
  const f = path.join(dir, 's1.tired');
  if (mark) fs.writeFileSync(f, '');
  const r = runScript(SCRIPT, typeof input === 'string' ? input : JSON.stringify(input), { BAJZI_STATUS_DIR: dir });
  return { r, f };
};
test('compact + marker -> Rules as additionalContext, marker kept', () => {
  const { r, f } = go({ session_id: 's1', source: 'compact' });
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, 'SessionStart');
  assert.match(o.additionalContext, /^Tired mode is ON for this session/);
  assert.match(o.additionalContext, /Plain wording, short, one decision at a time/);
  assert.ok(!/Arguments empty/.test(o.additionalContext));
  assert.ok(fs.existsSync(f)); assert.equal(r.code, 0);
});
test('compact without marker -> nothing', () => {
  const { r } = go({ session_id: 's1', source: 'compact' }, false);
  assert.deepEqual([r.code, r.stdout], [0, '']);
});
test('other sources delete the marker, print nothing', () => {
  for (const source of ['startup', 'clear', 'resume']) {
    const { r, f } = go({ session_id: 's1', source });
    assert.deepEqual([r.code, r.stdout], [0, ''], source); assert.ok(!fs.existsSync(f), source);
  }
});
test('fail-open: garbage, unsafe id, no stdin', () => {
  for (const i of ['not json', '', { session_id: '../x', source: 'compact' }, { source: 'compact' }]) {
    const { r } = go(i);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  }
});
