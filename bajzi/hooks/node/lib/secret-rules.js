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
  'base64', 'xxd', 'od', 'diff', 'sort', 'cut', 'jq', 'hexdump', 'format-hex', 'fhx']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh', 'pwsh',
  'powershell', 'deno', 'bun', 'cmd']);
// Right-hand sides that read PATHS (not data) from a pipe: PowerShell cmdlets bind the piped
// FileInfo/string to -Path; `cat`/`type` do so only in PowerShell (aliases of Get-Content).
const PIPE_PATH_READERS = new Set(['get-content', 'gc', 'select-string', 'sls', 'import-csv', 'format-hex', 'fhx']);
const PS_PIPE_PATH_ALIASES = new Set(['cat', 'type']);
const GIT_READ_SUBCMDS = new Set(['show', 'cat-file', 'blame', 'diff', 'log', 'grep']);
const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice']);
const RTK_WRAPPERS = new Set(['proxy', 'err', 'test']);   // rtk <wrapper> <any command>
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/i;
const BRACE_LIST = /^\{[^\s{}]*,[^\s{}]*\}/;   // {a,b} glued into a word = brace expansion, not a block
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

// {a,b} lists expanded, innermost first, capped at 64 results.
function expandBraces(s, out = []) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m || out.length >= 64) { out.push(s); return out; }
  for (const alt of m[1].split(',')) expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), out);
  return out;
}

// A glob (or a shell / PowerShell arg) names a protected file if one of its brace alternatives or
// comma-separated parts does, by its last segment taken literally (`*.pem`) or with the
// wildcards removed (`.env*` -> `.env`).
function matchGlobPattern(glob, extraPatterns = []) {
  if (typeof glob !== 'string' || !glob.trim()) return null;
  for (const alt of expandBraces(glob)) {
    for (const part of alt.split(',')) {
      const last = baseName(part);
      const h = matchProtected(last, extraPatterns) || matchProtected(last.replace(/[*?[\]]/g, ''), extraPatterns);
      if (h) return h;
    }
  }
  return null;
}

// Words per command segment. Quotes group and are removed; a backslash is LITERAL (Windows
// paths); ; & | newline ( ) ` { } end a segment, except a {a,b} brace list glued into a word;
// < << > are their own words. splitCommand also flags a segment that pipes (single |) into the next.
function segments(cmd) {
  return splitCommand(cmd).map(s => s.words);
}

function splitCommand(cmd) {
  const segs = [];
  let words = [];
  let cur = '';
  let has = false;
  let q = null;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endSeg = (pipe = false) => { endWord(); if (words.length) segs.push({ words, pipe }); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '{') {
      const m = BRACE_LIST.exec(cmd.slice(i));
      if (m) { cur += m[0]; has = true; i += m[0].length - 1; continue; }
    }
    if (ch === '|') {
      if (cmd[i + 1] === '|') { i++; endSeg(); } else endSeg(true);
      continue;
    }
    if (';&\n\r()`{}'.includes(ch)) { endSeg(); continue; }
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
  return matchGlobPattern(a, extra) || (a.includes('=') ? matchGlobPattern(a.slice(a.lastIndexOf('=') + 1), extra) : null);
}

// The command a segment runs, past prefixes (sudo, env, VAR=1, timeout <d>, xargs <flags>,
// rtk proxy|err|test), and its args minus redirects. `read` is a reader only as `rtk read`.
function resolve(words) {
  let i = 0;
  let rtk = false;
  let xargs = false;
  while (i < words.length) {
    const n = cmdName(words[i]);
    if (PREFIXES.has(n) || ASSIGNMENT.test(words[i])) { i++; continue; }
    if (n === 'timeout') { i++; while (i < words.length && !DURATION.test(words[i])) i++; i++; continue; }
    if (n === 'xargs') { xargs = true; i++; while (i < words.length && /^(-|\d+$)/.test(words[i])) i++; continue; }
    if (n === 'rtk') {
      i++;
      rtk = true;
      if (i < words.length && RTK_WRAPPERS.has(words[i].toLowerCase())) { i++; rtk = false; }
      continue;
    }
    break;
  }
  if (i >= words.length) return null;
  const name = cmdName(words[i]);
  const args = [];
  for (let k = i + 1; k < words.length; k++) {
    const w = words[k];
    if (w === '<' || w === '<<' || w === '>') { k++; continue; }   // redirect + its target
    args.push(w);
  }
  return { name, args, xargs, reader: READERS.has(name) || (rtk && name === 'read') };
}

function codeMentionsProtected(code, extra) {
  for (const piece of String(code).split(/[\s'"`(),;+=<>[\]{}]+/)) {
    const hit = matchProtected(piece, extra);
    if (hit) return hit;
  }
  return null;
}

// Does this pipe right-hand side read the left side's output as PATHS? `| sort`, `| head`,
// Bash `| cat` read it as data (listing a secret's name is fine).
function readsPathsFromStdin(c, shell) {
  if (!c || !c.reader) return false;
  return c.xargs || PIPE_PATH_READERS.has(c.name) || (shell === 'PowerShell' && PS_PIPE_PATH_ALIASES.has(c.name));
}

// shell: the tool name ('Bash' | 'PowerShell'); only changes how a pipe into cat/type is read.
function commandReadsProtected(cmd, extraPatterns = [], shell = 'Bash') {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (DOTNET_READ.test(cmd)) {
    const h = codeMentionsProtected(cmd, extraPatterns);
    if (h) return h;
  }
  const segs = splitCommand(cmd).map(s => ({ ...s, cmd: resolve(s.words) }));
  for (let j = 0; j < segs.length; j++) {
    const { words, cmd: c } = segs[j];
    for (let k = 0; k < words.length - 1; k++) {
      if (words[k] === '<') {
        const h = matchGlobPattern(words[k + 1], extraPatterns);
        if (h) return h;
      }
    }
    if (!c) continue;
    const { name, args } = c;
    // `Get-ChildItem .env | Get-Content`, `echo .env | head | xargs cat`: a protected name piped into
    // a reader that takes it as a path, at ANY later stage of the same pipeline.
    let downstream = false;
    for (let k = j; segs[k] && segs[k].pipe && segs[k + 1]; k++) {
      if (readsPathsFromStdin(segs[k + 1].cmd, shell)) { downstream = true; break; }
    }
    if (downstream) {
      for (const a of args) { const h = matchArg(a, extraPatterns); if (h) return h; }
    }
    if (c.reader) {
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
