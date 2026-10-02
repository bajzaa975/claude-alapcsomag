'use strict';
// Shared by the hook tests. NOT a test file (no .test.js suffix), so `node --test` skips it.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The owner's home directory is itself a git work tree on the laptop and os.tmpdir() lives under
// it: stop git discovery at the tmpdir so "not a repo" fixtures really are outside any repo.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const NODE_DIR = path.join(__dirname, '..');

function tmpDir(prefix = 'bajzi-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Runs a script with `stdin`. HOME/USERPROFILE and TMPDIR/TMP/TEMP point at throwaway dirs so a
// test never touches the real ~/.claude or the real tmpdir bridge files. extraEnv value
// undefined = delete that variable.
function runScript(script, stdin, extraEnv = {}, opts = {}) {
  const home = extraEnv.HOME || tmpDir('bajzi-home-');
  const tmp = extraEnv.TMPDIR || tmpDir('bajzi-tmp-');
  const env = Object.assign({}, process.env, {
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  });
  for (const k of ['ANTHROPIC_BASE_URL', 'CC_WORKER_MODE', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'NO_COLOR', 'BAJZI_WORKER_CMD']) delete env[k];
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [script], {
    input: stdin, env, encoding: 'utf8', timeout: 15000, cwd: opts.cwd,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', home, tmp, ms };
}

// A copy of pre-tool.js + post-tool.js whose check modules are probes naming themselves in the
// output (a deny on PreToolUse, a context on PostToolUse): the output lists the checks that ran.
function probeCopy() {
  const dir = tmpDir('bajzi-probe-');
  fs.mkdirSync(path.join(dir, 'lib'));
  for (const f of ['pre-tool.js', 'post-tool.js', path.join('lib', 'hook-io.js')]) {
    fs.copyFileSync(path.join(NODE_DIR, f), path.join(dir, f));
  }
  for (const c of ['context-guard', 'secret-guard', 'injection-scan']) {
    fs.writeFileSync(path.join(dir, `${c}.js`), `module.exports = { check: i => i.hook_event_name === 'PostToolUse'
      ? { kind: 'context', text: 'probe:${c}' } : { kind: 'deny', rule: 'probe', reason: 'probe:${c}' } };\n`);
  }
  return dir;
}

function p95(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

module.exports = { NODE_DIR, tmpDir, runScript, p95, probeCopy };
