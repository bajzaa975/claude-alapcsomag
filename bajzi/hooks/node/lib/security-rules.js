'use strict';
// Rule table for security-patterns.js; the rule set is inspired by the security-guidance plugin (Apache-2.0), regexes and texts are our own.
// Every regex uses bounded quantifiers only (no nested/overlapping unbounded groups): linear on 200 KB.
const JS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const PY = ['.py', '.pyi', '.ipynb'];
const DOC = ['.md', '.mdx', '.txt', '.rst'];

const EVENT = /\$\{\{\s*github\.event\./;
const RUN = /^([ \t]*)(?:-[ \t]+)?run:[ \t]*(.{0,300})/;
// Line scan (no multi-line regex): github.event.* inside a run: value, inline or in a | / > block.
function ghaEventInRun(text) {
  let block = -1; // indent of the open run: block, -1 = none
  for (const line of text.split('\n')) {
    const m = RUN.exec(line);
    if (m) {
      block = /^[|>][-+]?\s*$/.test(m[2]) ? m[1].length : -1;
      if (block < 0 && EVENT.test(line)) return true;
    } else if (block >= 0) {
      if (/^\s*$/.test(line)) continue;
      if (/^[ \t]*/.exec(line)[0].length <= block) block = -1;
      else if (EVENT.test(line)) return true;
    }
  }
  return false;
}

const RULES = [
  { id: 'node-exec-interpolated', exts: JS, re: /(?:child_process\.|(?<![\w.$]))exec(?:Sync)?\(\s*(?:`[^`\n]{0,300}\$\{|["'][^"'\n]{0,300}["']\s*\+)/,
    msg: 'A shell command is built from interpolated input; use execFile/spawn with an args array so input is never parsed by a shell.' },
  { id: 'py-shell-injection', exts: PY, re: /\bshell\s*=\s*True\b|\bos\.system\s*\(|\bsubprocess\.\w+\(\s*(?:f["']|["'][^"'\n]{0,200}["']\s*[+%])/,
    msg: 'Shell execution from a built string; pass an argument list without shell=True.' },
  { id: 'go-exec-shell', exts: ['.go'], re: /exec\.Command\(\s*"(?:sh|bash|\/bin\/sh|\/bin\/bash)"/,
    msg: 'Running a shell with a command string invites injection; call the program directly with separate arguments.' },
  { id: 'eval', exts: [...JS, ...PY], re: /(?<![\w.$])eval\s*\(/,
    msg: 'eval runs arbitrary code; parse data with JSON or a real parser instead.' },
  { id: 'new-function', exts: JS, re: /\bnew\s+Function\s*\(/,
    msg: 'new Function compiles a string into code, the same risk as eval; avoid it for anything derived from input.' },
  { id: 'pickle-load', exts: PY, re: /\b(?:c?[pP]ickle|dill|cloudpickle)\.loads?\s*\(|\bpickle\.Unpickler\b|\bmarshal\.loads?\s*\(/,
    msg: 'Unpickling untrusted bytes executes code; use JSON or a schema-validated format.' },
  { id: 'yaml-load', exts: PY, re: /\byaml\.(?:unsafe_)?load\s*\((?![^)\n]{0,80}Safe)/,
    msg: 'yaml.load can construct arbitrary objects; use yaml.safe_load.' },
  { id: 'torch-load', exts: PY, re: /\btorch\.load\s*\((?![^)\n]{0,120}weights_only\s*=\s*True)/,
    msg: 'torch.load unpickles by default; pass weights_only=True for plain tensors.' },
  { id: 'html-injection', exts: JS, re: /\.(?:inner|outer)HTML\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdangerouslySetInnerHTML\b|\bdocument\.write(?:ln)?\s*\(/,
    msg: 'Raw HTML sinks enable XSS when fed untrusted text; use textContent or sanitize the markup first.' },
  { id: 'sql-concat', exts: null, re: /["'`]\s*(?:SELECT\b[^"'`\n]{0,200}\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^;\n]{0,200}?(?:\$\{|["'`]\s*\+|["']\s*%\s*[\w(])|\bf["'](?:SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]{0,200}\{/i,
    msg: 'SQL assembled from variables is injectable; use placeholders with bound parameters.' },
  { id: 'aws-key-id', exts: null, re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    msg: 'This looks like an AWS access key id; keep credentials in the environment or a secret store, not in code.' },
  { id: 'private-key-block', exts: null, re: /-----BEGIN (?:[A-Z]{1,10} ){0,2}PRIVATE KEY-----/,
    msg: 'A private key block is being written into a file; load keys from a secret store instead.' },
  { id: 'hardcoded-password', exts: null, re: /\b(?:password|passwd|pwd|secret|api_?key|auth_?token)\w{0,20}\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    msg: 'A credential is hardcoded as a literal; read it from configuration or the environment.' },
  { id: 'tls-verify-off', exts: null, re: /\bverify\s*=\s*False\b|\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0\b|\bInsecureSkipVerify\s*:\s*true\b/,
    msg: 'Certificate verification is switched off, which allows man-in-the-middle attacks; fix the trust store instead.' },
  { id: 'chmod-777', exts: null, re: /\bchmod\s+(?:-R\s+)?0?777\b|\bchmod(?:Sync)?\([^)\n]{0,100},\s*0o?777\b/,
    msg: 'World-writable permissions let any local user modify the file; grant the narrowest mode needed.' },
  { id: 'gha-event-in-run', exts: ['.yml', '.yaml'], pathRe: /(?:^|[\\/])\.github[\\/]workflows[\\/]/,
    re: { test: ghaEventInRun },
    msg: 'Event data (titles, bodies, branch names) interpolated into run: is shell-injectable; pass it through env: and quote the variable.' },
];

function extOf(p) {
  const m = /\.[A-Za-z0-9]+$/.exec(p || '');
  return m ? m[0].toLowerCase() : '';
}

// Rules that fire on `text` for file `file`. Doc-like files never match.
function scanText(text, file) {
  const ext = extOf(file);
  if (DOC.includes(ext)) return [];
  return RULES.filter(r => (!r.exts || r.exts.includes(ext)) && (!r.pathRe || r.pathRe.test(file)) && r.re.test(text));
}

module.exports = { RULES, scanText, extOf };
