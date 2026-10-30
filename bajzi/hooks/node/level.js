'use strict';
// level.js (UserPromptSubmit): the owner-only `/bajzi:level` command, spec §6.1. The typed line is
// handled here and ALWAYS blocked ({"decision":"block","reason":<result>}): the skill never expands,
// no model turn runs, so the model can neither run nor influence it. A session with no person at the
// keyboard (CLAUDE_CODE_SESSION_ATTENDED=0 or an sdk entrypoint) is refused. Any other prompt: exit 0,
// no output. Fail-open via runHook.
// ponytail: an orchestrator that types into the pane counts as the owner; no way to tell them apart.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readInput, runHook, writeAll } = require('./lib/hook-io');

const MATCH = /^\s*\/bajzi:level(\s|$)/;
const WORDS = ['claude', 'light', 'glm', 'tight'];
const SCOPES = ['session', 'repo', 'global'];
const USAGE = 'usage: /bajzi:level [<0-3|L0-L3|claude|light|glm|tight> [session|repo|global]] | /bajzi:level unset [session|repo|global]';
const NOSWITCH = ' The level does not switch the provider of a session that is already running: a GLM session starts with worker (or glm).';

function atomicWrite(target, text) {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    created = true;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (created) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
    throw e;
  }
}

function parseLevel(t) {
  const m = /^l?([0-3])$/.exec(t);
  if (m) return WORDS[Number(m[1])];
  return WORDS.includes(t) ? t : null;
}

// The word resolveLevel reads from the file (the same readModeFile); '-' = nothing there.
function show(file, LEVELS, readModeFile) {
  const w = readModeFile(file);
  return w ? `L${Object.prototype.hasOwnProperty.call(LEVELS, w) ? LEVELS[w] : 0}` : '-';
}

function handle(input, env, home) {
  const { resolveLevel, hostOf, readModeFile, LEVELS } = require('./lib/saver-level');
  const ss = require('./lib/session-status');
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0' || String(env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk')) {
    return '/bajzi:level works only in an interactive session (the owner types it).';
  }
  const sid = input.session_id;
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const proj = String(env.CLAUDE_PROJECT_DIR || '') || cwd;   // the repo default sits at the project root, as in resolveLevel
  const dir = ss.statusDir(Object.assign({}, env, { BAJZI_HOME: env.BAJZI_HOME || home }));
  const safe = typeof sid === 'string' && ss.SAFE_ID.test(sid);
  const files = {
    session: safe ? path.join(dir, `${sid}.level`) : null,
    repo: proj ? path.join(proj, 'runtime', 'worker-mode') : null,
    global: path.join(home, '.claude', 'worker-mode'),
  };
  const eff = () => resolveLevel({ env, home, sessionId: sid, cwd });
  const host = hostOf(env.ANTHROPIC_BASE_URL);
  const provider = host !== null && host !== 'anthropic.com' && !host.endsWith('.anthropic.com');   // resolveLevel forces tight there but keeps the src of the word
  const from = (r) => provider ? 'ANTHROPIC_BASE_URL (a non-Anthropic provider)' : r.src;
  const tail = (scope) => {
    const r = eff();
    let s = `This session is now L${r.level} (${r.word}) from ${from(r)}.`;
    const own = { session: 'session', repo: 'repo', global: 'machine' }[scope];
    if (scope && provider) s += ` Note: ANTHROPIC_BASE_URL (a non-Anthropic provider) still wins over the ${scope} scope: the level is always L3 there.`;
    else if (scope && r.src !== own) s += ` Note: ${r.src === 'env' ? 'CC_WORKER_MODE' : r.src === 'inherited' ? 'BAJZI_SESSION_LEVEL' : `the ${r.src} level`} still wins over the ${scope} scope.`;
    return s + (r.level >= 2 ? NOSWITCH : '');
  };
  const need = (scope) => {
    if (files[scope]) return null;
    return scope === 'session' ? 'refused: this session has no safe session id.' : 'refused: no working directory in the hook input.';
  };

  const args = String(input.prompt).trim().split(/\s+/).slice(1).map(t => t.toLowerCase());
  const scopeOf = (t) => { const s = t === undefined ? 'session' : t.replace(/^--/, ''); return SCOPES.includes(s) ? s : null; };

  if (args.length === 0) {
    const r = eff();
    return [`This session: L${r.level} (${r.word}) from ${from(r)}.`,
      `session: ${files.session ? show(files.session, LEVELS, readModeFile) : '-'}`,
      `repo: ${files.repo ? show(files.repo, LEVELS, readModeFile) : '-'} (${files.repo || 'no project directory'})`,
      `global: ${show(files.global, LEVELS, readModeFile)} (~/.claude/worker-mode)`].join('\n');
  }
  if (args[0] === 'unset') {
    const scope = args.length <= 2 ? scopeOf(args[1]) : null;
    if (!scope) return USAGE;
    const bad = need(scope);
    if (bad) return bad;
    const had = fs.existsSync(files[scope]);
    fs.rmSync(files[scope], { force: true });
    return `${had ? `Removed the ${scope} level (${files[scope]}).` : `The ${scope} level is already unset.`}\n${tail(null)}`;
  }
  const word = parseLevel(args[0]);
  const scope = args.length <= 2 ? scopeOf(args[1]) : null;
  if (!word || !scope) return USAGE;
  const bad = need(scope);
  if (bad) return bad;
  atomicWrite(files[scope], word + '\n');
  let msg = `Wrote ${word} to ${files[scope]}.`;
  if (scope === 'repo' && files.session) {
    fs.rmSync(files.session, { force: true });
    msg += ' Removed this session\'s own level file, so this session follows the repo default now.';
  }
  return `${msg}\n${tail(scope)}`;
}

if (require.main === module) runHook('level', () => {
  const input = readInput();
  if (!input || typeof input.prompt !== 'string' || !MATCH.test(input.prompt)) return;
  let reason;
  try { reason = handle(input, process.env, os.homedir()); } catch (e) { reason = `/bajzi:level failed: ${String(e.message).slice(0, 200)}`; }
  writeAll(JSON.stringify({ decision: 'block', reason }));
});

module.exports = { handle, MATCH };
