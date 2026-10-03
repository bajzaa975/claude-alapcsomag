'use strict';
// lib/session-status.js: the status dir, atomic writes, appends and the 7-day prune shared by the
// session-signal hook, post-tool.js and the status line (the status record contract, spec §6.5).
const test = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const ss = require('../lib/session-status.js')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'))

test('writeJson writes atomically and refuses unsafe ids', () => {
  const d = tmp()
  assert.equal(ss.writeJson(d, 'abc-1.event.json', { v: 1 }), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'abc-1.event.json'))), { v: 1 })
  assert.equal(ss.writeJson(d, '../x.event.json', { v: 1 }), false)
  assert.deepEqual(fs.readdirSync(d), ['abc-1.event.json'])
})
test('a failing write returns false and never throws', () => {
  assert.equal(ss.writeJson(path.join(tmp(), 'missing', 'deeper\0'), 'a.event.json', {}), false)
})
test('prune deletes only files older than the limit', () => {
  const d = tmp(); const now = Date.now()
  for (const [n, age] of [['old.event.json', 8], ['new.event.json', 1]]) {
    const f = path.join(d, n); fs.writeFileSync(f, '{}'); const t = (now - age * 86400e3) / 1000; fs.utimesSync(f, t, t)
  }
  assert.equal(ss.prune(d, 7 * 86400e3, now), 1)
  assert.deepEqual(fs.readdirSync(d), ['new.event.json'])
})

test('writeJson: the status dir is created on first write; unsafe names of every shape are refused', () => {
  const d = path.join(tmp(), 'a', 'sessions')
  assert.equal(ss.writeJson(d, 's1.line.json', { v: 1 }), true)
  for (const n of ['x/y.event.json', 'x\\y.event.json', '.event.json', 'a'.repeat(129) + '.event.json', 's1', 's1.', 'é.event.json', 's1.event.json\0', 42, null]) {
    assert.equal(ss.writeJson(d, n, { v: 1 }), false, String(n))
  }
  assert.deepEqual(fs.readdirSync(d), ['s1.line.json'])
})

test('writeJson into a dir that is a file, or a target that is a dir, returns false and leaves no tmp file', () => {
  const d = tmp(); const f = path.join(d, 'file'); fs.writeFileSync(f, 'x')
  assert.equal(ss.writeJson(f, 's1.event.json', {}), false)
  fs.mkdirSync(path.join(d, 's1.event.json'))
  assert.equal(ss.writeJson(d, 's1.event.json', {}), false)
  assert.deepEqual(fs.readdirSync(d).sort(), ['file', 's1.event.json'])
})

test('writeJson never deletes a file at its tmp path that it did not create (wx collision)', (t) => {
  const d = tmp()
  t.mock.method(require('node:crypto'), 'randomBytes', () => Buffer.alloc(6))
  const planted = path.join(d, `s1.event.json.${process.pid}.000000000000.tmp`)
  fs.writeFileSync(planted, 'mine')
  assert.equal(ss.writeJson(d, 's1.event.json', { v: 1 }), false)
  assert.equal(fs.readFileSync(planted, 'utf8'), 'mine')
  assert.deepEqual(fs.readdirSync(d), [path.basename(planted)])
})

test('appendLine appends one JSON line per call; unsafe names and failures return false', () => {
  const d = tmp()
  assert.equal(ss.appendLine(d, 's1.artifacts.jsonl', { a: 1 }), true)
  assert.equal(ss.appendLine(d, 's1.artifacts.jsonl', { a: 2 }), true)
  assert.equal(fs.readFileSync(path.join(d, 's1.artifacts.jsonl'), 'utf8'), '{"a":1}\n{"a":2}\n')
  assert.equal(ss.appendLine(d, '../s1.artifacts.jsonl', {}), false)
  const f = path.join(d, 'file'); fs.writeFileSync(f, 'x')
  assert.equal(ss.appendLine(f, 's1.artifacts.jsonl', {}), false)
})

test('prune touches only status-record names (never a foreign file) and never throws', () => {
  const d = tmp(); const now = Date.now(); const t = (now - 30 * 86400e3) / 1000
  const names = ['s1.event.json', 's1.line.json', 's1.artifacts.jsonl', 's1.event.json.123.abcdef012345.tmp', 'notes.txt', 'keep.json', 'sub']
  for (const n of names) {
    const f = path.join(d, n)
    if (n === 'sub') fs.mkdirSync(f); else fs.writeFileSync(f, '{}')
    fs.utimesSync(f, t, t)
  }
  assert.equal(ss.prune(d, 7 * 86400e3, now), 4)
  assert.deepEqual(fs.readdirSync(d).sort(), ['keep.json', 'notes.txt', 'sub'])
  assert.equal(ss.prune(path.join(d, 'missing'), 1, now), 0)
})

test('statusDir: BAJZI_STATUS_DIR wins, else <BAJZI_HOME or home>/.claude/bajzi/sessions', () => {
  assert.equal(ss.statusDir({ BAJZI_STATUS_DIR: '/x/y' }), '/x/y')
  assert.equal(ss.statusDir({ BAJZI_HOME: '/h' }), path.join('/h', '.claude', 'bajzi', 'sessions'))
  assert.equal(ss.statusDir({}), path.join(os.homedir(), '.claude', 'bajzi', 'sessions'))
  assert.ok(ss.SAFE_ID.test('abc-1_X') && !ss.SAFE_ID.test('../x'))
})
