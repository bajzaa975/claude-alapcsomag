#!/usr/bin/env node
'use strict';
// bajzi:pre-push -- the bajzi pre-push hosting guard. Source: bajzi/gate/pre-push.js in the bajzi
// plugin; /bajzi:project-setup copies it verbatim to <repo>/.githooks/pre-push. Edit the source, never the copy.
//
// Refuses every push to a GitHub host unless <repo>/.claude/project-profile.json says
// "hosting": "github". Fails closed: a url whose host cannot be proven non-GitHub is refused.
// Git calls it as `pre-push <remote-name> <url>` (refs on stdin, not read). Exit 0 allow, 1 refuse.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PREFIX = 'bajzi pre-push: REFUSED: ';
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/;
const HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
const KINDS = { file: 'local', http: 'host', https: 'host', git: 'host', ssh: 'ssh', 'git+ssh': 'ssh', 'ssh+git': 'ssh' };

// "[user@]host[:port]" or "[user@][v6]:port" -> host ('' when absent).
function hostOf(auth, withPort) {
  let h = auth.slice(auth.lastIndexOf('@') + 1);
  if (h.startsWith('[')) return h.includes(']') ? h.slice(1, h.indexOf(']')) : '';
  if (withPort && h.split(':').length === 2) h = h.replace(/:\d*$/, '');
  return h;
}

function parseUrl(url) {
  let kind = 'local';
  let host = '';
  const m = SCHEME.exec(url);
  if (m) {
    kind = KINDS[m[1].toLowerCase()] || 'unknown';
    if (kind !== 'local') host = hostOf(m[2], true);
  } else if (HELPER.test(url)) {
    kind = 'unknown';
  } else if (/^[A-Za-z]:[\\/]/.test(url)) {
    kind = 'local';
  } else if (url.startsWith('[') && /^\[[^\]]*\]:/.test(url)) {
    // scp-like with a bracketed host: [host]:path or [user@host:port]:path
    kind = 'ssh';
    host = hostOf(url.slice(1, url.indexOf(']')), true);
  } else {
    const i = url.indexOf(':');
    if (i > 0 && !/[\\/]/.test(url.slice(0, i))) { kind = 'ssh'; host = hostOf(url.slice(0, i), false); }
  }
  // An empty host, or one shaped like an option, is never resolved: fail closed.
  if (kind !== 'local' && (!host || host.startsWith('-'))) kind = 'unknown';
  return kind === 'unknown' ? { kind, host: '' } : { kind, host };
}

function isGithubHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'github.com' || h.endsWith('.github.com');
}

// The real hostname ssh would connect to (resolves ssh-config aliases).
function sshResolve(host) {
  const r = spawnSync('ssh', ['-G', host], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return { error: `ssh -G ${host} failed` };
  const m = /^hostname\s+(\S+)/m.exec(r.stdout || '');
  return m ? { host: m[1] } : { error: `ssh -G ${host} printed no hostname` };
}

function hostingLabel(h) {
  if (h === undefined) return 'missing';
  return typeof h === 'string' ? JSON.stringify(h) : 'invalid';
}
const cannot = (url, reason) => ({ ok: false, line: `${PREFIX}cannot verify the host of ${url} (${reason}); hosting is not "github", so the push is refused` });

// hosting: the profile's "hosting" value (undefined = missing, null = unreadable profile).
function decide({ hosting, urls, resolveSsh = sshResolve }) {
  if (hosting === 'github') return { ok: true, line: '' };
  const github = (url, host) => ({ ok: false, line: `${PREFIX}${url} is GitHub (${host}); .claude/project-profile.json hosting is ${hostingLabel(hosting)} - set "hosting": "github" to allow it` });
  if (!urls.length) return cannot("''", 'no url');
  for (const url of urls) {
    if (!url) return cannot("''", 'empty url');
    const p = parseUrl(url);
    if (p.kind === 'local') continue;
    if (p.kind === 'unknown') return cannot(url, 'unknown transport or no host');
    if (isGithubHost(p.host)) return github(url, p.host);
    if (p.kind === 'ssh') {
      const r = resolveSsh(p.host);
      if (!r || r.error || !r.host) return cannot(url, (r && r.error) || 'ssh hostname unresolved');
      if (isGithubHost(r.host)) return github(url, r.host);
    }
  }
  return { ok: true, line: '' };
}

function readHosting(root) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, '.claude', 'project-profile.json'), 'utf8'); } catch { return undefined; }
  let v;
  try { v = JSON.parse(raw.replace(/^﻿/, '')); } catch { return null; }
  return v && typeof v === 'object' && !Array.isArray(v) ? v.hosting : null;
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const sh = (args, cwd) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    const top = sh(['rev-parse', '--show-toplevel']);
    const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
    const hosting = readHosting(root);
    if (hosting === 'github') return 0;
    const [name = '', url = ''] = argv;
    let urls = [];
    let fail = null;
    if (url) {
      // insteadOf rewrites of the url git passed, then the remote's push urls (pushInsteadOf), then the url itself.
      const lr = sh(['ls-remote', '--get-url', url], root);
      if (lr.status !== 0) fail = cannot(url, 'git ls-remote --get-url failed');
      else urls.push(lr.stdout.trim());
      if (!fail && name && name !== url) {
        const known = sh(['config', '--get-regexp', `^remote\\.${escRe(name)}\\.`], root);
        if (known.status > 1 || known.status === null) fail = cannot(url, 'git config failed');
        else if (known.status === 0) {
          const pu = sh(['remote', 'get-url', '--push', '--all', name], root);
          if (pu.status !== 0) fail = cannot(url, `git remote get-url --push ${name} failed`);
          else urls.push(...pu.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
        }
      }
      urls.push(url);
      urls = [...new Set(urls)];
    }
    const d = fail || decide({ hosting, urls });
    if (!d.ok) process.stdout.write(d.line + '\n');
    return d.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(cannot(argv[1] || "''", 'internal error: ' + e.message).line + '\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseUrl, isGithubHost, decide, main };
