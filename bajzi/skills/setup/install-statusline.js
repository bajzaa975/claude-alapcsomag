#!/usr/bin/env node
'use strict';
// /bajzi:setup step: copy hooks/node/statusline.js + hooks/node/lib/*.js to ~/.claude/bajzi/
// and point settings.json statusLine at the COPY (never at the versioned plugin cache path,
// which changes on every plugin update). `refresh` (SessionStart hook) re-copies an installed copy. settings.json is parsed BEFORE anything is written:
// an unparseable file is never overwritten. It is backed up before every change.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

// Atomic copy: write <dest>.<pid>.tmp, rename over the target (other sessions render the file
// every few hundred ms). Skips when the content is already identical. Returns true if it wrote.
function writeAtomic(dest, data) {
  try {
    if (Buffer.compare(fs.readFileSync(dest), Buffer.from(data)) === 0) return false;
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    throw e;
  }
  return true;
}

function pluginVersion(pluginRoot) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function semver(v) {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// lib/*.js FIRST, statusline.js LAST, then the version stamp. Returns true if anything changed.
function syncCopy(src, dest, version) {
  let changed = false;
  const lib = path.join(src, 'lib');
  for (const n of fs.readdirSync(lib).sort()) {
    if (n.endsWith('.js')) changed = writeAtomic(path.join(dest, 'lib', n), fs.readFileSync(path.join(lib, n))) || changed;
  }
  changed = writeAtomic(path.join(dest, 'statusline.js'), fs.readFileSync(path.join(src, 'statusline.js'))) || changed;
  if (version) changed = writeAtomic(path.join(dest, 'statusline.version'), version + '\n') || changed;
  return changed;
}

// Session-start refresh of an ALREADY installed copy. Never creates the folder, never touches
// settings.json, never downgrades (stamp newer than the running plugin).
function refresh({ pluginRoot, home }) {
  const dest = path.join(home, '.claude', 'bajzi');
  if (!fs.existsSync(path.join(dest, 'statusline.js'))) return { refreshed: false, reason: 'not-installed' };
  const version = pluginVersion(pluginRoot);
  if (!version) return { refreshed: false, reason: 'no-plugin-version' };
  let stamped = null;
  try { stamped = semver(fs.readFileSync(path.join(dest, 'statusline.version'), 'utf8')); } catch (_) { /* missing = older */ }
  if (stamped && cmp(stamped, semver(version)) > 0) return { refreshed: false, reason: 'newer-installed' };
  const refreshed = syncCopy(path.join(pluginRoot, 'hooks', 'node'), dest, version);
  return { refreshed, version };
}

// Never overwrites an existing backup: 'wx' + a counter suffix (-1, -2, ...) on a name clash.
function writeBackup(base, raw) {
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? base : `${base}-${i}`;
    try {
      fs.writeFileSync(name, raw, { flag: 'wx' });
      return name;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('no free backup name for ' + base);
}

function install({ pluginRoot, home, now = new Date() }) {
  const src = path.join(pluginRoot, 'hooks', 'node');
  const dest = path.join(home, '.claude', 'bajzi');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  let raw = null;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let settings = {};
  if (raw !== null) {
    settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json is not a JSON object');
  }
  syncCopy(src, dest, pluginVersion(pluginRoot));
  const command = `node "${path.join(dest, 'statusline.js').split(path.sep).join('/')}"`;
  const want = { type: 'command', command };
  if (JSON.stringify(settings.statusLine) === JSON.stringify(want)) {
    return { dest, command, settingsChanged: false, backup: null };
  }
  let backup = null;
  if (raw !== null) backup = writeBackup(`${settingsPath}.bak-bajzi-${stamp(now)}`, raw);
  settings.statusLine = want;
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
  return { dest, command, settingsChanged: true, backup };
}

if (require.main === module && process.argv[2] === 'refresh') {
  // SessionStart stdout goes into the model context: print nothing, swallow everything, exit 0.
  try {
    refresh({ pluginRoot: path.resolve(__dirname, '..', '..'), home: process.env.BAJZI_HOME || os.homedir() });
  } catch (_) { /* silent */ }
  process.exitCode = 0;
} else if (require.main === module) {
  try {
    const r = install({ pluginRoot: path.resolve(__dirname, '..', '..'), home: process.env.BAJZI_HOME || os.homedir() });
    process.stdout.write(`statusline installed: ${r.dest} (settings ${r.settingsChanged ? 'updated, backup ' + (r.backup || 'none (no previous file)') : 'unchanged'})\n`);
  } catch (e) {
    process.stdout.write(`statusline install FAILED: ${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { install, refresh, stamp };
