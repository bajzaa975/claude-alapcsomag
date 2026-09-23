#!/usr/bin/env node
'use strict';
// /bajzi:setup --check: compare THIS machine with manifest.json. READ-ONLY: it never writes,
// creates or deletes anything. One `DRIFT <id> <detail>` line per item; exit 1 on drift,
// 0 clean, 2 when the manifest cannot be read. BAJZI_HOME / BAJZI_MANIFEST override the
// home dir and manifest path (tests).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reviewerModels = require('../../hooks/node/lib/reviewer-models');

function readJson(p) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { ok: false, missing: e && e.code === 'ENOENT' };
  }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function onPath(name, env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      try { if (fs.statSync(path.join(d, name + e)).isFile()) return true; } catch { /* not here */ }
    }
  }
  return false;
}

function rtkConfigPath(home, env) {
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rtk', 'config.toml');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'rtk', 'config.toml');
}

function rtkExcludes(text) {
  const m = /^\s*exclude_commands\s*=\s*\[([\s\S]*?)\]/m.exec(String(text));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map(x => (x[1] !== undefined ? x[1] : x[2]));
}

function leafDiffs(want, have, prefix, out) {
  for (const k of Object.keys(want)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const w = want[k];
    const h = isObj(have) ? have[k] : undefined;
    if (Array.isArray(w)) {
      const hs = Array.isArray(h) ? h.map(x => JSON.stringify(x)) : [];
      for (const item of w) if (!hs.includes(JSON.stringify(item))) out.push(['setting-drift', `${key} missing ${JSON.stringify(item)}`]);
    } else if (isObj(w)) {
      leafDiffs(w, h, key, out);
    } else if (h !== w) {
      out.push(['setting-drift', `${key} is ${JSON.stringify(h)}, want ${JSON.stringify(w)}`]);
    }
  }
}

// "~/"-relative pattern, "*" allowed in the LAST segment only.
function globLast(home, pattern) {
  const rel = String(pattern).replace(/^~[\\/]/, '');
  const dir = path.join(home, path.dirname(rel));
  const last = path.basename(rel);
  if (!last.includes('*')) return fs.existsSync(path.join(home, rel)) ? [path.join(home, rel)] : [];
  const re = new RegExp('^' + last.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => re.test(n)).map(n => path.join(dir, n));
}

function repoMatches(have, want) {
  return have === want || have.endsWith('/' + want) || have.endsWith('/' + want + '.git');
}

function checkAll({ home, manifest, env = process.env }) {
  const d = [];
  const c = path.join(home, '.claude');

  const km = readJson(path.join(c, 'plugins', 'known_marketplaces.json'));
  if (!km.ok && !km.missing) d.push(['unreadable', 'plugins/known_marketplaces.json']);
  const markets = km.ok && isObj(km.value) ? km.value : {};
  const haveRepos = Object.entries(markets).map(([name, m]) => ({
    name, repo: String((m && m.source && (m.source.repo || m.source.url || m.source.path)) || '').toLowerCase(),
  }));
  const wantRepos = (manifest.marketplaces || []).map(m => String(m.source).toLowerCase());
  for (const w of wantRepos) if (!haveRepos.some(h => repoMatches(h.repo, w))) d.push(['marketplace-missing', w]);
  for (const h of haveRepos) if (!wantRepos.some(w => repoMatches(h.repo, w))) d.push(['marketplace-extra', h.name]);

  const ip = readJson(path.join(c, 'plugins', 'installed_plugins.json'));
  if (!ip.ok && !ip.missing) d.push(['unreadable', 'plugins/installed_plugins.json']);
  const pl = ip.ok && isObj(ip.value) && isObj(ip.value.plugins) ? ip.value.plugins : {};
  const userIds = Object.keys(pl).filter(id => Array.isArray(pl[id]) && pl[id].some(e => e && e.scope === 'user'));
  const wantIds = (manifest.plugins || []).map(p => p.id);
  for (const id of wantIds) if (!userIds.includes(id)) d.push(['plugin-missing', id]);
  for (const id of userIds) if (!wantIds.includes(id)) d.push(['plugin-extra', id]);

  const st = readJson(path.join(c, 'settings.json'));
  if (!st.ok) d.push([st.missing ? 'settings-missing' : 'unreadable', 'settings.json']);
  const settings = st.ok && isObj(st.value) ? st.value : {};
  if (st.ok) leafDiffs(manifest.settings_merge || {}, settings, '', d);

  const cmd = isObj(settings.statusLine) && typeof settings.statusLine.command === 'string' ? settings.statusLine.command : '';
  if (!cmd) d.push(['statusline-missing', 'settings.json has no statusLine.command']);
  else if (!cmd.replace(/\\/g, '/').includes('/.claude/bajzi/statusline.js')) d.push(['statusline-foreign', cmd]);
  if (!fs.existsSync(path.join(c, 'bajzi', 'statusline.js'))) d.push(['statusline-file-missing', '~/.claude/bajzi/statusline.js']);

  const cj = readJson(path.join(home, '.claude.json'));
  const mcps = cj.ok && isObj(cj.value) && isObj(cj.value.mcpServers) ? cj.value.mcpServers : {};
  for (const name of Object.keys(manifest.user_mcps || {})) if (!(name in mcps)) d.push(['mcp-missing', name]);

  if (manifest.rtk) {
    if (!onPath('rtk', env)) d.push(['rtk-missing', 'rtk not on PATH']);
    const want = Array.isArray(manifest.rtk.exclude_commands) ? manifest.rtk.exclude_commands : [];
    if (want.length) {
      let text = null;
      try { text = fs.readFileSync(rtkConfigPath(home, env), 'utf8'); } catch { text = null; }
      if (text === null) d.push(['rtk-config-missing', rtkConfigPath(home, env).split(path.sep).join('/')]);
      else {
        const have = rtkExcludes(text);
        for (const w of want) if (!have.includes(w)) d.push(['rtk-exclude-missing', w]);
      }
    }
  }

  if (!fs.existsSync(path.join(c, 'bajzi-mode'))) d.push(['bajzi-mode-missing', '~/.claude/bajzi-mode']);

  const wantRm = isObj(manifest.bajzi_config) ? manifest.bajzi_config.reviewer_models : undefined;
  if (Array.isArray(wantRm)) {
    const rm = reviewerModels.load(home);
    if (!rm.ok) d.push(['reviewer-models-invalid', rm.why]);
    else if (rm.ids.join(',') !== wantRm.join(',')) d.push(['reviewer-models-drift', `have ${rm.ids.join(',')}, manifest ${wantRm.join(',')}`]);
  }

  const fl = manifest.forbidden_leftovers || {};
  for (const pat of fl.paths || []) {
    for (const hit of globLast(home, pat)) d.push(['leftover', path.relative(home, hit).split(path.sep).join('/')]);
  }
  const hay = JSON.stringify({ hooks: settings.hooks || {}, allow: (isObj(settings.permissions) && settings.permissions.allow) || [] });
  for (const s of fl.settings_substrings || []) if (hay.includes(s)) d.push(['leftover-setting', s]);
  return d;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const home = env.BAJZI_HOME || os.homedir();
  const mpath = env.BAJZI_MANIFEST || path.join(__dirname, 'manifest.json');
  const m = readJson(mpath);
  if (!m.ok || !isObj(m.value)) {
    process.stdout.write(`setup --check: cannot read manifest ${mpath}\n`);
    return 2;
  }
  const drift = checkAll({ home, manifest: m.value, env });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ drift: drift.map(([id, detail]) => ({ id, detail })) }, null, 2) + '\n');
  } else {
    for (const [id, detail] of drift) process.stdout.write(`DRIFT ${id} ${detail}\n`);
    process.stdout.write(drift.length ? `setup --check: ${drift.length} drift item(s)\n` : 'setup --check: clean\n');
  }
  return drift.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkAll, main, onPath, rtkConfigPath, rtkExcludes };
