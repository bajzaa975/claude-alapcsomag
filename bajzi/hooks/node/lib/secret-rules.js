'use strict';
// Protected-path rules for the secret guard. PATTERN GUARD, NOT A SHELL PARSER: variable
// indirection (f=.env; cat $f), command substitution and encoded paths pass. Stated in the
// deny text and in bajzi/README.md.
// Rule ids: env-file, secrets-file, pattern:<glob from manifest.json secret_patterns>.
const fs = require('node:fs');
const path = require('node:path');

const ENV_ALLOWED = /\.(example|sample|template|dist)$/i;
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'gawk',
  'source', '.', 'type', 'get-content', 'gc', 'select-string', 'sls', 'import-csv', 'bat', 'nl', 'tac', 'strings',
  'base64', 'xxd', 'od']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh', 'pwsh',
  'powershell', 'deno', 'bun']);
const GIT_READ_SUBCMDS = new Set(['show', 'cat-file', 'blame', 'diff', 'log', 'grep']);
const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice']);
const DOTNET_READ = /\b(?:ReadAllText|ReadAllLines|ReadAllBytes|OpenText|ReadLines)\b/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripQuotes(s) {
  return String(s).trim().replace(/^["']+|["']+$/g, '');
}

function baseName(p) {
  const n = stripQuotes(p).replace(/\\/g, '/');
  const b = n.slice(n.lastIndexOf('/') + 1);
  return b.slice(b.lastIndexOf(':') + 1);
}

function globToRegex(glob) {
  const re = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp('^' + re + '$', 'i');
}

function matchProtected(p, extraPatterns = []) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const b = baseName(p);
  if (!b) return null;
  if (/^\.env$/i.test(b) || (/^\.env\..+/i.test(b) && !ENV_ALLOWED.test(b))) return { rule: 'env-file', path: p };
  if (/^\.secrets$/i.test(b)) return { rule: 'secrets-file', path: p };
  for (const g of extraPatterns) {
    if (typeof g === 'string' && g && globToRegex(g).test(b)) return { rule: 'pattern:' + g, path: p };
  }
  return null;
}

function isProtectedPath(p, extraPatterns = []) {
  return matchProtected(p, extraPatterns) !== null;
}

// A glob names a protected file if its last segment does, taken literally (`*.pem`) or with the
// wildcards removed (`.env*` -> `.env`).
function matchGlobPattern(glob, extraPatterns = []) {
  if (typeof glob !== 'string' || !glob.trim()) return null;
  const last = baseName(glob.replace(/[{}]/g, ''));
  return matchProtected(last, extraPatterns) || matchProtected(last.replace(/[*?[\]]/g, ''), extraPatterns);
}

// Words per command segment. Quotes group and are removed; a backslash is LITERAL (Windows
// paths); ; & | newline ( ) ` { } end a segment; < << > are their own words.
function segments(cmd) {
  const segs = [];
  let words = [];
  let cur = '';
  let has = false;
  let q = null;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (';&|\n\r()`{}'.includes(ch)) { endSeg(); continue; }
    if (ch === '<') {
      endWord();
      if (cmd[i + 1] === '<') { while (cmd[i + 1] === '<') i++; words.push('<<'); } else words.push('<');
      continue;
    }
    if (ch === '>') {
      endWord();
      while (cmd[i + 1] === '>' || cmd[i + 1] === '&') i++;
      words.push('>');
      continue;
    }
    cur += ch;
    has = true;
  }
  endSeg();
  return segs;
}

function cmdName(w) {
  return baseName(w).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function matchArg(a, extra) {
  return matchProtected(a, extra) || (a.includes('=') ? matchProtected(a.slice(a.lastIndexOf('=') + 1), extra) : null);
}

function codeMentionsProtected(code, extra) {
  for (const piece of String(code).split(/[\s'"`(),;+=<>[\]{}]+/)) {
    const hit = matchProtected(piece, extra);
    if (hit) return hit;
  }
  return null;
}

function commandReadsProtected(cmd, extraPatterns = []) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (DOTNET_READ.test(cmd)) {
    const h = codeMentionsProtected(cmd, extraPatterns);
    if (h) return h;
  }
  for (const words of segments(cmd)) {
    for (let k = 0; k < words.length - 1; k++) {
      if (words[k] === '<') {
        const h = matchProtected(words[k + 1], extraPatterns);
        if (h) return h;
      }
    }
    let i = 0;
    while (i < words.length && (PREFIXES.has(cmdName(words[i])) || ASSIGNMENT.test(words[i]))) i++;
    if (i >= words.length) continue;
    const name = cmdName(words[i]);
    const args = [];
    for (let k = i + 1; k < words.length; k++) {
      const w = words[k];
      if (w === '<' || w === '<<' || w === '>') { k++; continue; }   // redirect + its target
      args.push(w);
    }
    if (READERS.has(name)) {
      for (const a of args) { const h = matchArg(a, extraPatterns); if (h) return h; }
    } else if (name === 'git') {
      let sub = null;
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '-C' || args[k] === '-c') { k++; continue; }
        if (!args[k].startsWith('-')) { sub = args[k].toLowerCase(); break; }
      }
      if (sub && GIT_READ_SUBCMDS.has(sub)) {
        for (const a of args) { const h = matchArg(a, extraPatterns); if (h) return h; }
      }
    } else if (INTERPRETERS.has(name)) {
      for (const a of args) { const h = codeMentionsProtected(a, extraPatterns); if (h) return h; }
    }
  }
  return null;
}

function loadExtraPatterns(pluginRoot) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'skills', 'setup', 'manifest.json'), 'utf8'));
    return Array.isArray(m.secret_patterns) ? m.secret_patterns.filter(g => typeof g === 'string' && g) : [];
  } catch {
    return [];
  }
}

module.exports = {
  baseName, globToRegex, matchProtected, isProtectedPath, matchGlobPattern, segments, commandReadsProtected, loadExtraPatterns,
};
