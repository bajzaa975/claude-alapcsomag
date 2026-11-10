'use strict';
// Transcript reading shared by radar.js (usage digest) and ledger.js (sprint cost).
// Claude Code writes one JSONL line per content block, each repeating message.id and usage.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const num = v => (Number.isFinite(v) ? v : 0);
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) fn(l);
}

// <projectsDir>/*/*.jsonl and <projectsDir>/*/*/subagents/*.jsonl, mtime >= since.
function transcripts(dir, since) {
  const out = [];
  for (const p of ls(dir)) {
    if (!p.isDirectory()) continue;
    const pd = path.join(dir, p.name);
    for (const e of ls(pd)) {
      const ep = path.join(pd, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(ep);
      else if (e.isDirectory()) {
        const sd = path.join(ep, 'subagents');
        for (const s of ls(sd)) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(path.join(sd, s.name));
      }
    }
  }
  return out.filter(f => (mtime(f) ?? -Infinity) >= since);
}

// Adds one assistant message's usage to `models` (key -> {msgs,in,out,cr,cw}), once per message.id.
function addUsage(models, ids, msg, key) {
  const id = typeof msg.id === 'string' ? msg.id : null;
  if (id && ids.has(id)) return;
  if (id) ids.add(id);
  const r = models.get(key) || { msgs: 0, in: 0, out: 0, cr: 0, cw: 0 };
  const u = msg.usage || {};
  r.msgs++;
  r.in += num(u.input_tokens); r.out += num(u.output_tokens);
  r.cr += num(u.cache_read_input_tokens); r.cw += num(u.cache_creation_input_tokens);
  models.set(key, r);
}

module.exports = { num, mtime, ls, eachLine, transcripts, addUsage };
