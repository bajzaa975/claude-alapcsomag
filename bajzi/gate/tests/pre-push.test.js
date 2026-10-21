'use strict';
// Tests for the pre-push hosting guard: a unit matrix on `decide` (injected ssh resolver), policy
// and insteadOf cases through the hook in fixture repos, and end-to-end `git push` runs through
// the hook installed as .githooks/pre-push. Refusals are asserted by the hook's own REFUSED line.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'pre-push.js');
const { parseUrl, isGithubHost, decide, main } = require(HOOK);

const GH = 'bajzi pre-push: REFUSED: ';
const ghLine = (url, host) => `${GH}${url} is GitHub (${host});`;
const cannotLine = url => `${GH}cannot verify the host of ${url} (`;

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
// Isolate every git call from the developer's global and system config.
const EMPTY_GLOBAL = path.join(tmp('bajzi-prepush-cfg-'), 'gitconfig');
fs.writeFileSync(EMPTY_GLOBAL, '');
function env(extra = {}) {
  const e = { GIT_CONFIG_GLOBAL: EMPTY_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' };
  for (const [k, v] of Object.entries(process.env)) if (k !== 'NODE_TEST_CONTEXT' && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|SSH|SSH_COMMAND|SSH_VARIANT)$/i.test(k)) e[k] = v;
  return Object.assign(e, extra);
}
const git = (cwd, ...args) => spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
// env() with dir first on PATH (overwrites the existing PATH key, which is "Path" on Windows).
function withPath(dir, extra = {}) {
  const e = env(extra);
  const k = Object.keys(e).find(x => /^path$/i.test(x)) || 'PATH';
  e[k] = dir + path.delimiter + (e[k] || '');
  return e;
}

// Resolver map: host -> resolved hostname; a host not in the map fails to resolve.
const resolver = map => h => (h in map ? { host: map[h] } : { error: `ssh -G ${h} failed` });
const RES = resolver({ 'github.com': 'github.com', 'ssh.github.com': 'ssh.github.com', 'gh-alias': 'github.com', myserver: 'myserver' });
const run = (url, hosting = 'local', resolveSsh = RES) => decide({ hosting, urls: [url], resolveSsh });

test('GitHub urls are refused with the GitHub line', () => {
  for (const [url, host] of [
    ['https://github.com/o/r.git', 'github.com'],
    ['http://GitHub.com/o/r', 'GitHub.com'],
    ['git@github.com:o/r.git', 'github.com'],
    ['ssh://git@github.com:22/o/r.git', 'github.com'],
    ['ssh://git@ssh.github.com:443/o/r.git', 'ssh.github.com'],
    ['git+ssh://github.com/o/r', 'github.com'],
    ['gh-alias:o/r.git', 'github.com'],
  ]) {
    const d = run(url);
    assert.strictEqual(d.ok, false, url);
    assert.ok(d.line.startsWith(ghLine(url, host)), `${url}: ${d.line}`);
    assert.ok(d.line.includes('hosting is "local"'), d.line);
  }
});

test('unverifiable urls are refused with the cannot-verify line', () => {
  for (const url of ['git@unknownhost:r.git', 'ext::ssh x', '', 'foo://h/x', 'https:///x', '-oProxyCommand=x:r']) {
    const d = run(url);
    assert.strictEqual(d.ok, false, url);
    assert.ok(d.line.startsWith(cannotLine(url || "''")), `${url}: ${d.line}`);
  }
  const none = decide({ hosting: 'local', urls: [], resolveSsh: RES });
  assert.strictEqual(none.ok, false);
  assert.ok(none.line.startsWith(GH + 'cannot verify'), none.line);
});

test('non-GitHub urls are allowed with no line', () => {
  for (const url of ['D:/repos/x.git', 'C:\\repos\\x.git']) {
    assert.deepStrictEqual(decide({ hosting: 'local', urls: [url], resolveSsh: RES, platform: 'win32' }), { ok: true, line: '' }, url);
  }
  for (const url of ['../bare.git', '/srv/x.git', 'file:///tmp/x.git', 'https://gitlab.com/o/r', 'git@myserver:r.git']) {
    assert.deepStrictEqual(run(url), { ok: true, line: '' }, url);
  }
});

test('one GitHub url among several refuses', () => {
  const d = decide({ hosting: undefined, urls: ['../bare.git', 'https://github.com/o/r'], resolveSsh: RES });
  assert.ok(d.line.startsWith(ghLine('https://github.com/o/r', 'github.com')), d.line);
  assert.ok(d.line.includes('hosting is missing'), d.line);
});

test('hosting label: "local", missing, invalid', () => {
  const url = 'https://github.com/o/r';
  assert.ok(run(url, 'local').line.includes('hosting is "local" - set "hosting": "github" to allow it'));
  assert.ok(decide({ hosting: undefined, urls: [url], resolveSsh: RES }).line.includes('hosting is missing'));
  assert.ok(run(url, null).line.includes('hosting is invalid'));
  assert.ok(run(url, 5).line.includes('hosting is invalid'));
  assert.ok(run(url, 'GitHub').line.includes('hosting is "GitHub"'));
  assert.deepStrictEqual(run(url, 'github'), { ok: true, line: '' });
});

test('parseUrl kinds', () => {
  assert.deepStrictEqual(parseUrl('ssh://u@[::1]:22/r'), { kind: 'ssh', host: '::1' });
  assert.deepStrictEqual(parseUrl('[github.com]:o/r'), { kind: 'ssh', host: 'github.com' });
  assert.deepStrictEqual(parseUrl('HTTPS://u:p@Host.x:8080/r'), { kind: 'host', host: 'Host.x' });
  assert.strictEqual(parseUrl('ext::ssh x').kind, 'unknown');
  assert.strictEqual(parseUrl('D:\\x', 'win32').kind, 'local');
});

test('a drive-letter url is local only on win32; elsewhere it is ssh to that host', () => {
  assert.deepStrictEqual(parseUrl('g:/o/r', 'win32'), { kind: 'local', host: '' });
  assert.deepStrictEqual(parseUrl('g:/o/r', 'linux'), { kind: 'ssh', host: 'g' });
  const d = decide({ hosting: 'local', urls: ['g:/o/r'], resolveSsh: resolver({ g: 'github.com' }), platform: 'darwin' });
  assert.ok(d.line.startsWith(ghLine('g:/o/r', 'github.com')), d.line);
});

test('isGithubHost', () => {
  for (const h of ['github.com', 'GitHub.com.', '[github.com]', 'ssh.github.com', 'www.github.com']) assert.strictEqual(isGithubHost(h), true, h);
  for (const h of ['notgithub.com', 'github.com.evil', 'gitlab.com', '']) assert.strictEqual(isGithubHost(h), false, h);
});

// ---- the hook as a process, in fixture repos ----

function repo(profile) {
  const r = tmp('bajzi-prepush-');
  git(r, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(r, 'config', k, v);
  fs.writeFileSync(path.join(r, 'a.txt'), 'a\n');
  if (profile !== undefined) {
    fs.mkdirSync(path.join(r, '.claude'));
    fs.writeFileSync(path.join(r, '.claude', 'project-profile.json'), profile);
  }
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}
const hook = (r, args, e = env()) => {
  const x = spawnSync(process.execPath, [HOOK, ...args], { cwd: r, env: e, encoding: 'utf8' });
  return { code: x.status, out: (x.stdout || '') + (x.stderr || '') };
};

test('policy: only "hosting": "github" lets a GitHub push through', () => {
  const url = 'https://github.com/o/r.git';
  for (const [profile, label] of [
    ['{"hosting":"local"}', '"local"'],
    [undefined, 'missing'],
    ['{not json', 'invalid'],
    ['["github"]', 'invalid'],
    ['{"hosting":"GitHub"}', '"GitHub"'],
  ]) {
    const r = repo(profile);
    git(r, 'remote', 'add', 'origin', url);
    const x = hook(r, ['origin', url]);
    assert.strictEqual(x.code, 1, `${profile}: ${x.out}`);
    assert.ok(x.out.includes(ghLine(url, 'github.com')), x.out);
    assert.ok(x.out.includes(`hosting is ${label}`), x.out);
  }
  const ok = repo('\ufeff{"hosting":"github"}');
  git(ok, 'remote', 'add', 'origin', url);
  assert.deepStrictEqual(hook(ok, ['origin', url]), { code: 0, out: '' });
});

test('insteadOf rewrite to GitHub is refused', () => {
  const r = repo('{"hosting":"local"}');
  git(r, 'config', 'url.https://github.com/.insteadOf', 'gh:');
  git(r, 'remote', 'add', 'origin', 'gh:o/r');
  const x = hook(r, ['origin', 'gh:o/r']);
  assert.strictEqual(x.code, 1, x.out);
  assert.ok(x.out.includes(ghLine('https://github.com/o/r', 'github.com')), x.out);
});

test('a configured remote whose push urls go to GitHub is refused', () => {
  const r = repo('{"hosting":"local"}');
  git(r, 'remote', 'add', 'origin', '../bare.git');
  git(r, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/o/r.git');
  const x = hook(r, ['origin', '../bare.git']);
  assert.strictEqual(x.code, 1, x.out);
  assert.ok(x.out.includes(ghLine('https://github.com/o/r.git', 'github.com')), x.out);
});

test('the committed profile decides, not a working-tree edit', () => {
  const r = repo('{"hosting":"local"}');
  fs.writeFileSync(path.join(r, '.claude', 'project-profile.json'), '{"hosting":"github"}');
  const url = 'https://github.com/o/r.git';
  const x = hook(r, ['origin', url]);
  assert.strictEqual(x.code, 1, x.out);
  assert.ok(x.out.includes(ghLine(url, 'github.com')) && x.out.includes('hosting is "local"'), x.out);
});

test('ssh aliases are resolved by running ssh -G (fake ssh on PATH)', () => {
  const dir = tmp('bajzi-prepush-fakessh-');
  fs.writeFileSync(path.join(dir, 'ssh'), '#!/bin/sh\ncase "$FAKE_SSH_MODE" in fail) exit 3;; empty) echo "user git"; exit 0;; esac\necho "user git"\necho "hostname github.com"\n');
  fs.chmodSync(path.join(dir, 'ssh'), 0o755);
  const r = repo('{"hosting":"local"}');
  const url = 'gh-alias:o/r.git';
  const ok = hook(r, ['origin', url], withPath(dir));
  assert.strictEqual(ok.code, 1, ok.out);
  assert.ok(ok.out.includes(ghLine(url, 'github.com')), ok.out);
  for (const mode of ['fail', 'empty']) {
    const x = hook(r, ['origin', url], withPath(dir, { FAKE_SSH_MODE: mode }));
    assert.strictEqual(x.code, 1, `${mode}: ${x.out}`);
    assert.ok(x.out.includes(cannotLine(url)), `${mode}: ${x.out}`);
  }
});

test('ssh resolution uses git\'s ssh command (core.sshCommand with -F)', () => {
  const cfg = path.join(tmp('bajzi-prepush-sshcfg-'), 'config');
  fs.writeFileSync(cfg, 'Host work\n  HostName github.com\n');
  const r = repo('{"hosting":"local"}');
  git(r, 'config', 'core.sshCommand', `ssh -F "${cfg.replace(/\\/g, '/')}"`);
  const url = 'work:o/r.git';
  const x = hook(r, ['origin', url]);
  assert.strictEqual(x.code, 1, x.out);
  assert.ok(x.out.includes(ghLine(url, 'github.com')), x.out);
});

test('main fails closed when a git call fails or throws', () => {
  const r = repo('{"hosting":"local"}');
  const url = 'https://gitlab.com/o/r';
  git(r, 'remote', 'add', 'origin', url);
  const real = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, cwd: opts.cwd || r });
  const failing = (prefix, result) => (cmd, args, opts) => {
    if (!args.join(' ').startsWith(prefix)) return real(cmd, args, opts);
    if (result instanceof Error) throw result;
    return { stdout: '', ...result };
  };
  const runMain = (run, u = url) => {
    const orig = process.stdout.write;
    let out = '';
    process.stdout.write = s => { out += s; return true; };
    try { return { code: main(['origin', u], env(), run), out }; } finally { process.stdout.write = orig; }
  };
  const ssh = 'git@myserver:r.git';
  const sc = runMain(failing('config --get core.sshCommand', { status: 2 }), ssh);
  assert.strictEqual(sc.code, 1, sc.out);
  assert.ok(sc.out.startsWith(`${cannotLine(ssh)}git config core.sshCommand failed)`), sc.out);
  assert.deepStrictEqual(runMain(real), { code: 0, out: '' });
  for (const [prefix, result, reason] of [
    ['ls-remote --get-url', { status: 128 }, 'git ls-remote --get-url failed'],
    ['config --get-regexp', { status: 2 }, 'git config failed'],
    ['config --get-regexp', { status: null }, 'git config failed'],
    ['remote get-url --push', { status: 1 }, 'git remote get-url --push origin failed'],
    ['ls-remote', new Error('boom'), 'internal error: boom'],
  ]) {
    const x = runMain(failing(prefix, result));
    assert.strictEqual(x.code, 1, `${prefix}: ${x.out}`);
    assert.ok(x.out.startsWith(`${cannotLine(url)}${reason})`), `${prefix}: ${x.out}`);
  }
});

test('missing url argument is refused', () => {
  const r = repo('{"hosting":"local"}');
  const x = hook(r, []);
  assert.strictEqual(x.code, 1, x.out);
  assert.ok(x.out.includes(GH + 'cannot verify'), x.out);
});

// ---- end to end: git push through the installed hook ----

function e2e(profile, remoteUrl) {
  const r = repo(profile);
  const bare = tmp('bajzi-prepush-bare-');
  git(bare, 'init', '-q', '--bare');
  git(r, 'config', 'core.hooksPath', '.githooks');
  fs.mkdirSync(path.join(r, '.githooks'));
  const dst = path.join(r, '.githooks', 'pre-push');
  fs.writeFileSync(dst, fs.readFileSync(HOOK, 'utf8').replace(/\r\n/g, '\n'));
  fs.chmodSync(dst, 0o755);
  git(r, 'remote', 'add', 'origin', remoteUrl === 'BARE' ? bare : remoteUrl);
  // Fake ssh: ignores the host and serves the push from the local bare repo.
  const fake = path.join(tmp('bajzi-prepush-ssh-'), 'fake-ssh.js');
  fs.writeFileSync(fake, "const r = require('child_process').spawnSync('git', ['receive-pack', process.env.FAKE_BARE], { stdio: 'inherit' });\nprocess.exit(r.status === null ? 1 : r.status);\n");
  const fwd = p => p.replace(/\\/g, '/');
  const x = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], {
    cwd: r, encoding: 'utf8',
    env: env({ GIT_SSH_COMMAND: `"${fwd(process.execPath)}" "${fwd(fake)}"`, GIT_SSH_VARIANT: 'simple', FAKE_BARE: bare, GIT_TRACE: '1' }),
  });
  const refs = git(bare, 'for-each-ref', '--format=%(refname)').stdout.trim();
  return { code: x.status, out: (x.stdout || '') + (x.stderr || ''), refs };
}

test('e2e: push to github.com with hosting local is refused and the remote is unchanged', () => {
  const x = e2e('{"hosting":"local"}', 'git@github.com:o/r.git');
  assert.notStrictEqual(x.code, 0, x.out);
  assert.ok(x.out.includes(ghLine('git@github.com:o/r.git', 'github.com')), x.out);
  assert.strictEqual(x.refs, '');
});

test('e2e: push to github.com with hosting github succeeds', () => {
  const x = e2e('{"hosting":"github"}', 'git@github.com:o/r.git');
  assert.strictEqual(x.code, 0, x.out);
  assert.strictEqual(x.refs, 'refs/heads/main');
});

test('e2e: push to a local bare repo with hosting local succeeds through the hook', () => {
  const x = e2e('{"hosting":"local"}', 'BARE');
  assert.strictEqual(x.code, 0, x.out);
  assert.match(x.out, /run_command:.*pre-push/);
  assert.ok(!x.out.includes('REFUSED'), x.out);
  assert.strictEqual(x.refs, 'refs/heads/main');
});
