'use strict';
// Reply-language setting: `node lang.js get` prints the `language` key of
// ${BAJZI_HOME:-~}/.claude/bajzi/config.json (empty when unset/missing/unreadable, exit 0);
// `node lang.js set <code>` merges it in, keeping every other key (exit 2 on a bad code or a bad file).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const file = path.join(process.env.BAJZI_HOME || os.homedir(), '.claude', 'bajzi', 'config.json');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

const [cmd, code] = process.argv.slice(2);
if (cmd === 'get') {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8')).language;
    if (typeof l === 'string' && CODE.test(l)) process.stdout.write(l + '\n');
  } catch { /* unset: print nothing */ }
} else if (cmd === 'set') {
  if (typeof code !== 'string' || !CODE.test(code)) fail(`bad language code "${code || ''}": use e.g. hu, en, pt-BR`);
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`${file} is not valid JSON; left untouched`); }
    if (!isObj(cfg)) fail(`${file} is not a JSON object; left untouched`);
  }
  cfg.language = code;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(`language set to ${code}\n`);
} else fail('usage: lang.js get | set <code>');
