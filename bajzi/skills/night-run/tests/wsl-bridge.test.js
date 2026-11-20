'use strict';
// wsl-bridge.sh and night-hold.ps1: every external program (wsl.exe, powershell.exe, cygpath, uname)
// is a stub script on PATH that logs argv + stdin; the real wsl.exe / powershell.exe are never called.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..');
const BRIDGE = path.join(DIR, 'wsl-bridge.sh');
const ALL = ['flock', 'setsid', 'claude', 'gh', 'git', 'node', 'python3'];
const BASICS = ['sh', 'sed', 'sort', 'tail', 'head', 'ls', 'date', 'cat', 'grep', 'mkdir', 'sleep', 'seq', 'tr'];
const which = (n) => spawnSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const REAL_BASH = which('bash');

// stub wsl.exe: logs argv. `bash -l -s` (the run step) is canned. Everything else is really executed with
// PATH = the distro's own bin dir, and, like the real client, stdin is relayed (here: swallowed) and, WITHOUT
// --exec, the joined arguments are re-evaluated by a shell (sh -c "$*"), so $vars and $(...) expand early.
const WSL_STUB = `#!/usr/bin/env bash
log=$STUB_LOG
printf 'ARGV:%s\\n' "$*" >> "$log"
if [ "$1" = "-l" ]; then
  printf '%s' "$STUB_DISTROS" | sed 's/./&\\x00/g; s/$/\\r\\x00\\n\\x00/'; exit 0
fi
d=$2; shift 2
if [ "$1" = "--cd" ]; then shift 2; fi
case "$*" in
  "-- bash -l -s") { echo "STDIN-BEGIN"; cat; echo "STDIN-END"; } >> "$log"; exit "\${STUB_RUN_EXIT:-0}";;
esac
bin=$STUB_DIR/distro/$d/bin
[ -d "$bin" ] || exit 1
cat >/dev/null
export PATH=$bin
if [ "$1" = "--exec" ]; then shift; exec "$@"; fi
[ "$1" = "--" ] && shift
exec sh -c "$*"
`;

function sandbox(env = {}, unameS = 'MINGW64_NT-10.0', distros = { notools: [], Ubuntu: ALL, Debian: ALL }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslb-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const put = (n, body, b = bin) => fs.writeFileSync(path.join(b, n), body, { mode: 0o755 });
  put('wsl.exe', WSL_STUB);
  put('uname', `#!/bin/sh\necho ${unameS}\n`);
  put('cygpath', String.raw`#!/bin/sh
printf 'C:\\stub\\%s\n' "$(basename "$2")"
`);
  put('powershell.exe', `#!/bin/sh
printf 'PS:%s\\n' "$*" >> "$STUB_LOG"
if [ -n "$STUB_HOLD_LOG" ]; then
  nd=$(printf '%s' "$*" | sed "s/.*'-NightDir','\\([^']*\\)'.*/\\1/")
  mkdir -p "$nd/logs"; printf '%b' "$STUB_HOLD_LOG" > "$nd/logs/hold.log"
fi
if [ -n "$STUB_HOLD_LATE" ]; then
  nd=$(printf '%s' "$*" | sed "s/.*'-NightDir','\\([^']*\\)'.*/\\1/")
  mkdir -p "$nd/logs"
  (sleep "$STUB_HOLD_LATE"; echo LAUNCH-EXIT=0 >> "$nd/logs/hold.log") >/dev/null 2>&1 &
fi
`);
  const home = path.join(dir, 'home');
  const version = env.STUB_WSL_VERSION || '1.42.0';
  const plugin = path.join(home, '.claude/plugins/cache/bajzi-plugins/bajzi', version);
  fs.mkdirSync(plugin, { recursive: true });
  for (const [name, tools] of Object.entries(distros)) {
    const b = path.join(dir, 'distro', name, 'bin');
    fs.mkdirSync(b, { recursive: true });
    for (const t of BASICS) fs.symlinkSync(which(t), path.join(b, t));
    put('bash', `#!/bin/sh\ncase "$1" in -lc) shift; set -- -c "$@";; -l) shift;; esac\nexec ${REAL_BASH} "$@"\n`, b);
    put('wslpath', '#!/bin/sh\n[ -n "$2" ] || exit 1\necho /mnt/d/proj\n', b);
    for (const t of tools) {
      put(t, {
        claude: '#!/bin/sh\nexit "${STUB_CLAUDE_EXIT:-0}"\n',
        gh: '#!/bin/sh\ncase "$1" in auth) exit "${STUB_GH_EXIT:-0}";; repo) exit "${STUB_REPO_EXIT:-0}";; esac\n',
        git: '#!/bin/sh\necho https://github.com/o/p\n',
      }[t] || '#!/bin/sh\nexit 0\n', b);
    }
  }
  const nd = path.join(dir, 'night-runs', 'proj');
  fs.mkdirSync(nd, { recursive: true });
  const log = path.join(dir, 'stub.log');
  fs.writeFileSync(log, '');
  const base = {
    PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_DIR: dir, HOME: home,
    STUB_DISTROS: 'docker-desktop\nnotools\nUbuntu', STUB_WSL_VERSION: version,
    STUB_HOLD_LOG: 'settings listing\nlaunched, waiting 10 s\nLAUNCH-EXIT=0\n', BAJZI_HOLD_WAIT: '2',
    CLAUDE_PLUGIN_ROOT: 'C:\\Users\\x\\.claude\\plugins\\cache\\bajzi-plugins\\bajzi\\1.42.0',
  };
  const e = { ...base, ...env };
  const sh = (args, input) => spawnSync('bash', [BRIDGE, ...args], { env: e, input, encoding: 'utf8' });
  return { sh, nd, home, plugin, log: () => fs.readFileSync(log, 'utf8') };
}

test('pick skips docker-desktop and a distro failing the tool check', () => {
  const s = sandbox({ STUB_DISTROS: 'docker-desktop\nnotools\nUbuntu' });
  const r = s.sh(['pick']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'DISTRO=Ubuntu');
  assert.doesNotMatch(s.log(), /-d docker-desktop/);
  assert.match(s.log(), /-d notools/);
});

test('pick with no usable distro fails closed: exit 3 and a plain reason', () => {
  const s = sandbox({ STUB_DISTROS: 'docker-desktop\nnotools' }, undefined, { notools: [] });
  const r = s.sh(['pick']);
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /no WSL distro/);
  assert.strictEqual(r.stdout, '');
});

test('BAJZI_WSL_DISTRO is honoured and still verified', () => {
  const ok = sandbox({ BAJZI_WSL_DISTRO: 'Debian', STUB_DISTROS: 'Ubuntu' });
  assert.strictEqual(ok.sh(['pick']).stdout.trim(), 'DISTRO=Debian');
  const bad = sandbox({ BAJZI_WSL_DISTRO: 'Debian', STUB_DISTROS: 'Ubuntu' }, undefined, { Ubuntu: ALL, Debian: ['flock'] });
  assert.strictEqual(bad.sh(['pick']).status, 3);
});

test('pick skips a distro that has only some of the seven tools', () => {
  const s = sandbox({ STUB_DISTROS: 'Partial\nUbuntu' }, undefined, { Partial: ['flock', 'setsid', 'git'], Ubuntu: ALL });
  const r = s.sh(['pick']);
  assert.strictEqual(r.stdout.trim(), 'DISTRO=Ubuntu', r.stderr);
  const only = sandbox({ STUB_DISTROS: 'Partial' }, undefined, { Partial: ALL.slice(0, 6) });
  assert.strictEqual(only.sh(['pick']).status, 3);
});

test('pick: a failing first distro cannot swallow the rest of the list (wsl.exe relays stdin)', () => {
  const s = sandbox({ STUB_DISTROS: 'bare\nUbuntu' }, undefined, { bare: [], Ubuntu: ALL });
  const r = s.sh(['pick']);
  assert.strictEqual(r.stdout.trim(), 'DISTRO=Ubuntu', r.stderr);
});

test('every wsl.exe script goes through --exec: no outer shell expands it first', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  assert.doesNotMatch(src, /wsl\.exe [^\n]*-- bash -lc/);
});

test('check: WSL 1.41.0 vs Windows 1.42.0 -> exit 4 with the update command', () => {
  const s = sandbox({ STUB_WSL_VERSION: '1.41.0' });
  const r = s.sh(['check']);
  assert.strictEqual(r.status, 4);
  assert.match(r.stderr, /bajzi in WSL is 1\.41\.0, Windows has 1\.42\.0; update it in WSL with: claude plugin update bajzi@bajzi-plugins/);
});

test('check: equal versions print the KEY=VALUE lines', () => {
  const s = sandbox();
  const r = s.sh(['check']);
  assert.strictEqual(r.status, 0, r.stderr);
  const kv = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.strictEqual(kv.DISTRO, 'Ubuntu');
  assert.strictEqual(kv.WSL_CWD, '/mnt/d/proj');
  assert.strictEqual(kv.WSL_PLUGIN_ROOT, s.plugin);
  assert.strictEqual(kv.WSL_VERSION, '1.42.0');
  assert.strictEqual(kv.WIN_VERSION, '1.42.0');
  assert.strictEqual(kv.WIN_NIGHT_ROOT, `\\\\wsl.localhost\\Ubuntu${s.home.replace(/\//g, '\\')}\\night-runs`);
});

test('check: gh not logged in inside WSL -> exit 5', () => {
  const r = sandbox({ STUB_GH_EXIT: '1' }).sh(['check']);
  assert.strictEqual(r.status, 5);
  assert.match(r.stderr, /gh/);
});

test('check: claude not logged in inside WSL -> exit 6 with a plain reason', () => {
  const r = sandbox({ STUB_CLAUDE_EXIT: '1' }).sh(['check']);
  assert.strictEqual(r.status, 6);
  assert.match(r.stderr, /claude is not logged in/);
});

test('check: GitHub cannot see the project repo -> exit 7 with a plain reason', () => {
  const r = sandbox({ STUB_REPO_EXIT: '1' }).sh(['check']);
  assert.strictEqual(r.status, 7);
  assert.match(r.stderr, /GitHub cannot see the project repo/);
});

test('run passes the step byte-for-byte on stdin after the CLAUDE_PLUGIN_ROOT prefix and the exit code through', () => {
  const s = sandbox({ STUB_RUN_EXIT: '7' });
  const step = "cat > /mnt/d/x <<'EOF'\nhello \"q\" $HOME\nEOF\necho '/mnt/d/x \"q\" $HOME'\n";
  const r = s.sh(['run'], step);
  assert.strictEqual(r.status, 7);
  const log = s.log();
  const m = log.match(/STDIN-BEGIN\n([\s\S]*)STDIN-END/);
  assert.ok(m, log);
  const [prefix, ...rest] = m[1].split('\n');
  assert.match(prefix, new RegExp('^export CLAUDE_PLUGIN_ROOT=' + s.plugin.replace(/[.*+?^${}()|[\\]\\\\\/]/g, '\\$&') + '; cd /mnt/d/proj;$'));
  assert.strictEqual(rest.join('\n'), step);
  assert.match(log, /ARGV:-d Ubuntu --cd C:\\stub\\.* -- bash -l -s/);
});

test('run with DISTRO, WSL_CWD and WSL_PLUGIN_ROOT in the env skips every lookup', () => {
  const s = sandbox({ DISTRO: 'Ubuntu', WSL_CWD: '/mnt/d/p', WSL_PLUGIN_ROOT: '/r/1.42.0' });
  assert.strictEqual(s.sh(['run'], 'true\n').status, 0);
  assert.strictEqual(s.log().split('\n').filter((l) => l.startsWith('ARGV:')).length, 1);
  assert.match(s.log(), /export CLAUDE_PLUGIN_ROOT=\/r\/1\.42\.0; cd \/mnt\/d\/p;/);
});

// launch.sh as PHASE C renders it: the deadline is a local "YYYY-MM-DD HH:MM".
function withLaunchSh(s, epoch) {
  const d = new Date(epoch * 1000);
  const z = (n) => String(n).padStart(2, '0');
  const dl = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
  fs.writeFileSync(path.join(s.nd, 'launch.sh'), `setsid nohup bash "/r/run.sh" --config "$ND/config.env" --deadline "${dl}" --date "2026-11-20" &\n`);
}

test('launch starts the hidden holder with the ps1 path, distro, ND and UntilEpoch = deadline + 7200', () => {
  const deadline = Math.floor(Date.now() / 60000) * 60 + 3600;
  const s = sandbox();
  withLaunchSh(s, deadline);
  const r = s.sh(['launch', s.nd]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /holder started/);
  assert.ok(r.stdout.includes(`${s.nd}/logs/hold.log`));
  assert.match(r.stdout, /launched, waiting 10 s/, 'launch.sh output reaches the session');
  const ps = s.log().split('\n').find((l) => l.startsWith('PS:'));
  assert.ok(ps, s.log());
  assert.match(ps, /Start-Process powershell\.exe -WindowStyle Hidden/);
  assert.ok(ps.includes('night-hold.ps1'));
  assert.ok(ps.includes("'-Distro','Ubuntu'"));
  assert.ok(ps.includes(`'-NightDir','${s.nd}'`));
  assert.ok(ps.includes(`'-UntilEpoch','${deadline + 7200}'`), ps);
});

test('launch falls back to now + 72 h when launch.sh has no readable deadline', () => {
  const s = sandbox();
  const before = Math.floor(Date.now() / 1000);
  s.sh(['launch', s.nd]);
  const m = s.log().match(/'-UntilEpoch','(\d+)'/);
  assert.ok(m, s.log());
  assert.ok(Math.abs(Number(m[1]) - (before + 259200)) < 60);
});

test('launch: a launch.sh refusal in hold.log reaches the session and is not reported as success', () => {
  const s = sandbox({ STUB_HOLD_LOG: 'BACKUP FAILED - nothing was overwritten\nLAUNCH-EXIT=1\n' });
  withLaunchSh(s, Math.floor(Date.now() / 1000) + 3600);
  const r = s.sh(['launch', s.nd]);
  assert.strictEqual(r.status, 8);
  assert.match(r.stdout, /BACKUP FAILED/);
  assert.doesNotMatch(r.stdout, /holder started/);
  assert.match(r.stderr, /launch\.sh refused/);
});

test('launch: no LAUNCH-EXIT line in time -> exit 9 (outcome unknown), not success and not refused', () => {
  const s = sandbox({ STUB_HOLD_LOG: 'half a log\n' });
  const r = s.sh(['launch', s.nd]);
  assert.strictEqual(r.status, 9);
  assert.doesNotMatch(r.stdout, /holder started/);
  assert.match(r.stdout, /half a log/);
  assert.match(r.stderr, /launch outcome not known yet: the holder is still running; check for the runner/);
  assert.doesNotMatch(r.stderr, /refused/);
});

test('launch: the holder writes LAUNCH-EXIT=0 only after the wait ended -> exit 9, not refused', () => {
  const s = sandbox({ STUB_HOLD_LOG: '', STUB_HOLD_LATE: '3', BAJZI_HOLD_WAIT: '1' });
  const r = s.sh(['launch', s.nd]);
  assert.strictEqual(r.status, 9);
  assert.match(r.stderr, /not known yet/);
  assert.doesNotMatch(r.stderr, /refused/);
  assert.doesNotMatch(r.stdout, /holder started/);
});

test('not Git Bash (uname) or an unknown subcommand -> usage, exit 2', () => {
  assert.strictEqual(sandbox({}, 'Linux').sh(['pick']).status, 2);
  assert.strictEqual(sandbox().sh(['frobnicate']).status, 2);
  assert.strictEqual(sandbox().sh([]).status, 2);
});

test('night-hold.ps1 keeps the PC awake, starts launch.sh, holds one client on the flock and caps at UntilEpoch', () => {
  const p = fs.readFileSync(path.join(DIR, 'night-hold.ps1'), 'utf8');
  assert.ok(p.includes('SetThreadExecutionState'));
  // Windows PowerShell 5.1: a bare 0x8xxxxxxx literal is a negative Int32 and does not convert to uint
  assert.doesNotMatch(p, /0x[89a-f][0-9a-f]{7}\b/i, 'no bare high-bit hex literal');
  assert.ok(p.includes('SetThreadExecutionState(2147483649)'), 'CONTINUOUS|SYSTEM_REQUIRED as unsigned decimal');
  assert.ok(p.includes('SetThreadExecutionState(2147483648)'), 'CONTINUOUS only on release');
  assert.match(p, /--exec flock -w \$left "\$NightDir\/run\.flock" true/);
  assert.ok(p.includes('$UntilEpoch'));
  assert.ok(p.includes('launch.sh'));
  assert.ok(p.includes('LAUNCH-EXIT=$?'));
  assert.doesNotMatch(p, /Start-Sleep|while \(/, 'one long-lived client, no poll loop with gaps');
  assert.ok(/^[\x00-\x7f]*$/.test(p) && !p.includes('\r'), 'ASCII only');
});

test('wsl-bridge.sh is ASCII only', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(fs.readFileSync(BRIDGE, 'utf8')));
});
