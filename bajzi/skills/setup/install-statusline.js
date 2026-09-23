#!/usr/bin/env node
'use strict';
// /bajzi:setup step: copy hooks/node/statusline.js + hooks/node/lib/*.js to ~/.claude/bajzi/
// and point settings.json statusLine at the COPY (never at the versioned plugin cache path,
// which changes on every plugin update). settings.json is parsed BEFORE anything is written:
// an unparseable file is never overwritten. It is backed up before every change.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

function copyJs(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const n of fs.readdirSync(srcDir)) {
    if (n.endsWith('.js')) fs.copyFileSync(path.join(srcDir, n), path.join(destDir, n));
  }
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
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'statusline.js'), path.join(dest, 'statusline.js'));
  copyJs(path.join(src, 'lib'), path.join(dest, 'lib'));
  const command = `node "${path.join(dest, 'statusline.js').split(path.sep).join('/')}"`;
  const want = { type: 'command', command };
  if (JSON.stringify(settings.statusLine) === JSON.stringify(want)) {
    return { dest, command, settingsChanged: false, backup: null };
  }
  let backup = null;
  if (raw !== null) {
    backup = `${settingsPath}.bak-bajzi-${stamp(now)}`;
    fs.writeFileSync(backup, raw);
  }
  settings.statusLine = want;
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
  return { dest, command, settingsChanged: true, backup };
}

if (require.main === module) {
  try {
    const r = install({ pluginRoot: path.resolve(__dirname, '..', '..'), home: process.env.BAJZI_HOME || os.homedir() });
    process.stdout.write(`statusline installed: ${r.dest} (settings ${r.settingsChanged ? 'updated, backup ' + (r.backup || 'none (no previous file)') : 'unchanged'})\n`);
  } catch (e) {
    process.stdout.write(`statusline install FAILED: ${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { install, stamp };
