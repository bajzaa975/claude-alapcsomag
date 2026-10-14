#!/usr/bin/env node
// Builds bajzi-cowork/ — the claude.ai / Cowork-safe variant of the bajzi plugin.
// Why: claude.ai-hosted marketplace sync rejects plugins that ship bin/ executables
// (bajzi has bin/ since 1.7.0; claude.ai stayed on 1.5.15 with "Sync failed").
// The variant ships ONLY skills that need nothing outside their own folder:
// no bin/, hooks/, agents/, gate/, lib/. Source of truth stays bajzi/skills/<name>.
// Usage: node tools/build-cowork.js          (rebuild + stamp versions)
//        node tools/build-cowork.js --check  (exit 1 on any drift, writes nothing)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'bajzi');
const DST = path.join(ROOT, 'bajzi-cowork');
const MARKET = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const SKILLS = ['autopilot', 'handoff', 'modszertan'];
const EXCLUDE_DIRS = new Set(['tests']);
const DESCRIPTION = 'claude.ai / Cowork-safe subset of bajzi: /bajzi-cowork:handoff session handover, ' +
  '/bajzi-cowork:autopilot unattended mode, /bajzi-cowork:modszertan methodology selector. ' +
  'Skills only - no bin/, hooks or agents. Built from bajzi/ by tools/build-cowork.js; do not edit by hand.';

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) out.push(...listFiles(p, base)); }
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function expected() {
  const src = JSON.parse(fs.readFileSync(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8'));
  const files = new Map();
  for (const s of SKILLS) {
    const dir = path.join(SRC, 'skills', s);
    for (const f of listFiles(dir)) files.set(`skills/${s}/${f}`, fs.readFileSync(path.join(dir, f)));
  }
  const plugin = {
    name: 'bajzi-cowork', version: src.version, description: DESCRIPTION,
    author: src.author, license: src.license, keywords: src.keywords,
  };
  files.set('.claude-plugin/plugin.json', Buffer.from(JSON.stringify(plugin, null, 2) + '\n'));
  return { version: src.version, files };
}

function marketEntry(version) {
  return {
    name: 'bajzi-cowork', version, source: './bajzi-cowork',
    description: 'claude.ai / Cowork-safe subset of bajzi (handoff, autopilot, modszertan skills only; no bin/, hooks or agents). Install this one in claude.ai / Cowork; use bajzi in Claude Code.',
    category: 'productivity',
  };
}

function drift() {
  const { version, files } = expected();
  const problems = [];
  const actual = fs.existsSync(DST) ? listFiles(DST).filter((f) => f !== 'README.md') : [];
  for (const f of actual) if (!files.has(f)) problems.push(`extra: bajzi-cowork/${f}`);
  for (const [f, buf] of files) {
    const p = path.join(DST, f);
    if (!fs.existsSync(p)) problems.push(`missing: bajzi-cowork/${f}`);
    else if (!fs.readFileSync(p).equals(buf)) problems.push(`differs: bajzi-cowork/${f}`);
  }
  const m = JSON.parse(fs.readFileSync(MARKET, 'utf8'));
  const e = m.plugins.find((p) => p.name === 'bajzi-cowork');
  if (!e) problems.push('marketplace.json: no bajzi-cowork entry');
  else if (JSON.stringify(e) !== JSON.stringify(marketEntry(version))) problems.push('marketplace.json: bajzi-cowork entry differs');
  return problems;
}

function build() {
  const { version, files } = expected();
  fs.rmSync(path.join(DST, 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(DST, '.claude-plugin'), { recursive: true, force: true });
  for (const [f, buf] of files) {
    const p = path.join(DST, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  const m = JSON.parse(fs.readFileSync(MARKET, 'utf8'));
  const i = m.plugins.findIndex((p) => p.name === 'bajzi-cowork');
  if (i === -1) m.plugins.push(marketEntry(version)); else m.plugins[i] = marketEntry(version);
  fs.writeFileSync(MARKET, JSON.stringify(m, null, 2) + '\n');
  return version;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const p = drift();
    if (p.length) { console.error('bajzi-cowork DRIFT:\n  ' + p.join('\n  ') + '\nRun: node tools/build-cowork.js'); process.exit(1); }
    console.log('bajzi-cowork in sync');
  } else {
    console.log(`bajzi-cowork built at ${build()}`);
  }
}

module.exports = { drift, SKILLS, DST };
