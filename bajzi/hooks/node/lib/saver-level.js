'use strict';
// Node port of the LEVEL part of hooks/lib-saver-level.sh (saver_resolve). KEEP IN SYNC:
// hooks/tests/saver-level-cases.json is run against BOTH implementations
// (hooks/node/tests/saver-level.test.js and hooks/tests/saver-level-parity.sh).
// Byte-level mirror of the bash: tr -d '[:space:]' removes 0x20 and 0x09-0x0D; tr upper->lower
// is ASCII-only; head -1 = up to the first LF; one leading UTF-8 BOM is dropped from the file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEVELS = Object.freeze({ claude: 0, light: 1, glm: 2, tight: 3 });
const WS = /[ \t\n\v\f\r]/g;

function lowerAscii(s) {
  return s.replace(/[A-Z]/g, c => c.toLowerCase());
}

// ${_url#*://}  ${h%%[/?#\\]*}  ${h##*@}  ${h%%:*}  -- in that order.
function hostOf(rawUrl) {
  const url = lowerAscii(String(rawUrl === undefined || rawUrl === null ? '' : rawUrl).replace(WS, ''));
  if (!url) return null;
  let h = url;
  const i = h.indexOf('://');
  if (i >= 0) h = h.slice(i + 3);
  const j = h.search(/[/?#\\]/);
  if (j >= 0) h = h.slice(0, j);
  const k = h.lastIndexOf('@');
  if (k >= 0) h = h.slice(k + 1);
  const p = h.indexOf(':');
  if (p >= 0) h = h.slice(0, p);
  return h;
}

function readWorkerModeFile(home) {
  const p = path.join(home, '.claude', 'worker-mode');
  try {
    if (!fs.statSync(p).isFile()) return '';
    let line = fs.readFileSync(p);
    const nl = line.indexOf(0x0a);
    if (nl >= 0) line = line.subarray(0, nl);
    if (line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) line = line.subarray(3);
    return lowerAscii(line.toString('latin1').replace(WS, ''));
  } catch {
    return '';
  }
}

function resolveLevel({ env = process.env, home = os.homedir() } = {}) {
  const host = hostOf(env.ANTHROPIC_BASE_URL);
  const nonAnthropic = host !== null && !(host === 'anthropic.com' || host.endsWith('.anthropic.com'));
  let word = lowerAscii(String(env.CC_WORKER_MODE || '').replace(WS, ''));
  if (!word) word = readWorkerModeFile(home);
  if (!word) word = 'claude';
  if (nonAnthropic) word = 'tight';
  const level = Object.prototype.hasOwnProperty.call(LEVELS, word) ? LEVELS[word] : 0;
  return { level, word };
}

module.exports = { resolveLevel, hostOf, LEVELS };
