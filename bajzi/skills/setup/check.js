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

// Overlay merge: objects recurse, arrays concatenate (deduped), scalars: overlay wins.
function mergeSettings(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(a.map(x => JSON.stringify(x)));
    return a.concat(b.filter(x => !seen.has(JSON.stringify(x))));
  }
  if (isObj(a) && isObj(b)) {
    const o = Object.assign({}, a);
    for (const k of Object.keys(b)) o[k] = k in a ? mergeSettings(a[k], b[k]) : b[k];
    return o;
  }
  return b;
}

const TAG = /^\[[^\]\s][^\]]*\]/;
// Entries carrying a `[tag]` prefix that the wanted array no longer has, while it still has the tag.
function staleDiffs(want, have, prefix, out) {
  for (const k of Object.keys(want)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const w = want[k];
    const h = isObj(have) ? have[k] : undefined;
    if (Array.isArray(w) && Array.isArray(h)) {
      const tags = new Set(w.filter(x => typeof x === 'string').map(x => (TAG.exec(x) || [])[0]).filter(Boolean));
      for (const x of h) {
        const t = typeof x === 'string' ? (TAG.exec(x) || [])[0] : undefined;
        if (t && tags.has(t) && !w.includes(x)) out.push(['setting-drift', `${key} stale ${x.slice(0, 60)}`]);
      }
    } else if (isObj(w)) staleDiffs(w, h, key, out);
  }
}

const OVERLAY_REL = ['.claude', 'bajzi', 'settings-local.json'];

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

// Optional `addon_marketplaces` in ~/.claude/bajzi/config.json: marketplace names whose entries and
// plugins are never "extra". Missing/unparseable file or missing key = [] (an unparseable file is
// already reported as reviewer-models-invalid); a present but invalid value = [] + invalid:true.
const ADDON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function addonMarketplaces(home) {
  const cfg = readJson(path.join(home, '.claude', 'bajzi', 'config.json'));
  if (!cfg.ok || !isObj(cfg.value) || !Object.prototype.hasOwnProperty.call(cfg.value, 'addon_marketplaces')) return { names: [], invalid: false };
  const v = cfg.value.addon_marketplaces;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !ADDON_NAME.test(x))) return { names: [], invalid: true };
  return { names: v, invalid: false };
}

function checkAll({ home, manifest, env = process.env }) {
  const d = [];
  const c = path.join(home, '.claude');
  const addons = addonMarketplaces(home);

  const km = readJson(path.join(c, 'plugins', 'known_marketplaces.json'));
  if (!km.ok && !km.missing) d.push(['unreadable', 'plugins/known_marketplaces.json']);
  const markets = km.ok && isObj(km.value) ? km.value : {};
  const haveRepos = Object.entries(markets).map(([name, m]) => ({
    name, repo: String((m && m.source && (m.source.repo || m.source.url || m.source.path)) || '').toLowerCase(),
  }));
  const wantRepos = (manifest.marketplaces || []).map(m => String(m.source).toLowerCase());
  for (const w of wantRepos) if (!haveRepos.some(h => repoMatches(h.repo, w))) d.push(['marketplace-missing', w]);
  for (const h of haveRepos) if (!addons.names.includes(h.name) && !wantRepos.some(w => repoMatches(h.repo, w))) d.push(['marketplace-extra', h.name]);

  const ip = readJson(path.join(c, 'plugins', 'installed_plugins.json'));
  if (!ip.ok && !ip.missing) d.push(['unreadable', 'plugins/installed_plugins.json']);
  const pl = ip.ok && isObj(ip.value) && isObj(ip.value.plugins) ? ip.value.plugins : {};
  const userIds = Object.keys(pl).filter(id => Array.isArray(pl[id]) && pl[id].some(e => e && e.scope === 'user'));
  const wantIds = (manifest.plugins || []).map(p => p.id);
  for (const id of wantIds) if (!userIds.includes(id)) d.push(['plugin-missing', id]);
  for (const id of userIds) if (!wantIds.includes(id) && !addons.names.some(n => id.endsWith('@' + n))) d.push(['plugin-extra', id]);

  const st = readJson(path.join(c, 'settings.json'));
  if (!st.ok) d.push([st.missing ? 'settings-missing' : 'unreadable', 'settings.json']);
  const settings = st.ok && isObj(st.value) ? st.value : {};
  let wantSettings = manifest.settings_merge || {};
  const ov = readJson(path.join(home, ...OVERLAY_REL));
  if (ov.ok && isObj(ov.value)) wantSettings = mergeSettings(wantSettings, ov.value);
  else if (!ov.missing) d.push(['settings-overlay', 'unreadable']);
  if (st.ok) { leafDiffs(wantSettings, settings, '', d); staleDiffs(wantSettings, settings, '', d); }

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

  let rulesSrc = null;
  try { rulesSrc = fs.readFileSync(path.join(c, 'plugins', 'marketplaces', 'bajzi-plugins', 'shared', 'CLAUDE.md'), 'utf8'); } catch { /* no source: skip */ }
  if (rulesSrc !== null) {
    let mine = '';
    try { mine = fs.readFileSync(path.join(c, 'CLAUDE.md'), 'utf8'); } catch { /* none yet: every heading missing */ }
    const have = new Set(mine.split(/\r?\n/).map(l => l.trimEnd()));
    for (const l of rulesSrc.split(/\r?\n/)) if (l.startsWith('## ') && !have.has(l.trimEnd())) d.push(['global-rules', `missing "${l.trimEnd()}"`]);
  }

  if (!fs.existsSync(path.join(c, 'bajzi-mode'))) d.push(['bajzi-mode-missing', '~/.claude/bajzi-mode']);

  const wantRm = isObj(manifest.bajzi_config) ? manifest.bajzi_config.reviewer_models : undefined;
  if (Array.isArray(wantRm)) {
    const rm = reviewerModels.load(home);
    if (!rm.ok) d.push(['reviewer-models-invalid', rm.why]);
    else if (rm.ids.join(',') !== wantRm.join(',')) d.push(['reviewer-models-drift', `have ${rm.ids.join(',')}, manifest ${wantRm.join(',')}`]);
  }

  if (addons.invalid) d.push(['bajzi-config', 'addon_marketplaces invalid']);

  const fl = manifest.forbidden_leftovers || {};
  for (const pat of fl.paths || []) {
    for (const hit of globLast(home, pat)) d.push(['leftover', path.relative(home, hit).split(path.sep).join('/')]);
  }
  const hay = JSON.stringify({ hooks: settings.hooks || {}, allow: (isObj(settings.permissions) && settings.permissions.allow) || [] });
  for (const s of fl.settings_substrings || []) if (hay.includes(s)) d.push(['leftover-setting', s]);
  const deny = (isObj(settings.permissions) && Array.isArray(settings.permissions.deny)) ? settings.permissions.deny : [];
  for (const x of fl.deny_rules || []) if (x && deny.includes(x.rule)) d.push(['leftover-deny', `${x.rule}: ${x.why}`]);
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
    if (!fs.existsSync(path.join(home, ...OVERLAY_REL))) process.stdout.write('note: no machine-local settings overlay (~/.claude/bajzi/settings-local.json)\n');
    for (const [id, detail] of drift) process.stdout.write(`DRIFT ${id} ${detail}\n`);
    process.stdout.write(drift.length ? `setup --check: ${drift.length} drift item(s)\n` : 'setup --check: clean\n');
  }
  return drift.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkAll, mergeSettings, main, onPath, rtkConfigPath, rtkExcludes };
