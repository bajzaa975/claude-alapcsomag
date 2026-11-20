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
const ND = '/home/u/night-runs/proj';

const WSL_STUB = `#!/usr/bin/env bash
# stub wsl.exe: logs "argv" and stdin to $STUB_LOG, answers by command shape.
log=$STUB_LOG
printf 'ARGV:%s\\n' "$*" >> "$log"
if [ "$1" = "-l" ]; then
  printf '%s' "$STUB_DISTROS" | sed 's/./&\\x00/g; s/$/\\r\\x00\\n\\x00/'; exit 0
fi
d=$2
rest="$*"
case "$rest" in
  *"command -v flock"*) case " $STUB_OK " in *" $d "*) exit 0;; *) exit 1;; esac;;
  *"sort -V"*) echo "$STUB_WSL_VERSION|/home/u/.claude/plugins/cache/bajzi-plugins/bajzi/$STUB_WSL_VERSION|/home/u"; exit 0;;
  *"gh auth status"*) exit "\${STUB_GH_EXIT:-0}";;
  *wslpath*) cat >> "$log"; echo "/mnt/d/proj"; exit 0;;
  *"--deadline"*) cat >> "$log"; echo "$STUB_UNTIL"; exit 0;;
  *"bash -l -s"*) { echo "STDIN-BEGIN"; cat; echo "STDIN-END"; } >> "$log"; exit "\${STUB_RUN_EXIT:-0}";;
esac
exit 0
`;

function sandbox(env = {}, unameS = 'MINGW64_NT-10.0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslb-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const put = (n, body) => fs.writeFileSync(path.join(bin, n), body, { mode: 0o755 });
  put('wsl.exe', WSL_STUB);
  put('uname', `#!/bin/sh\necho ${unameS}\n`);
  put('cygpath', String.raw`#!/bin/sh
printf 'C:\\stub\\%s\n' "$(basename "$2")"
`);
  put('powershell.exe', '#!/bin/sh\nprintf \'PS:%s\\n\' "$*" >> "$STUB_LOG"\n');
  const log = path.join(dir, 'stub.log');
  fs.writeFileSync(log, '');
  const base = {
    PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, HOME: dir,
    STUB_DISTROS: 'docker-desktop\nnotools\nUbuntu', STUB_OK: 'Ubuntu',
    STUB_WSL_VERSION: '1.42.0', CLAUDE_PLUGIN_ROOT: 'C:\\Users\\x\\.claude\\plugins\\cache\\bajzi-plugins\\bajzi\\1.42.0',
  };
  const e = { ...base, ...env };
  const sh = (args, input) => spawnSync('bash', [BRIDGE, ...args], { env: e, input, encoding: 'utf8' });
  return { sh, log: () => fs.readFileSync(log, 'utf8') };
}

test('pick skips docker-desktop and a distro failing the tool check', () => {
  const s = sandbox({ STUB_DISTROS: 'docker-desktop\nnotools\nUbuntu', STUB_OK: 'Ubuntu' });
  const r = s.sh(['pick']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'DISTRO=Ubuntu');
  assert.doesNotMatch(s.log(), /-d docker-desktop/);
  assert.match(s.log(), /-d notools/);
});

test('pick with no usable distro fails closed: exit 3 and a plain reason', () => {
  const s = sandbox({ STUB_DISTROS: 'docker-desktop\nnotools', STUB_OK: '' });
  const r = s.sh(['pick']);
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /no WSL distro/);
  assert.strictEqual(r.stdout, '');
});

test('BAJZI_WSL_DISTRO is honoured and still verified', () => {
  const ok = sandbox({ BAJZI_WSL_DISTRO: 'Debian', STUB_OK: 'Debian Ubuntu', STUB_DISTROS: 'Ubuntu' });
  assert.strictEqual(ok.sh(['pick']).stdout.trim(), 'DISTRO=Debian');
  const bad = sandbox({ BAJZI_WSL_DISTRO: 'Debian', STUB_OK: 'Ubuntu', STUB_DISTROS: 'Ubuntu' });
  assert.strictEqual(bad.sh(['pick']).status, 3);
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
  assert.strictEqual(kv.WSL_PLUGIN_ROOT, '/home/u/.claude/plugins/cache/bajzi-plugins/bajzi/1.42.0');
  assert.strictEqual(kv.WSL_VERSION, '1.42.0');
  assert.strictEqual(kv.WIN_VERSION, '1.42.0');
  assert.strictEqual(kv.WIN_NIGHT_ROOT, '\\\\wsl.localhost\\Ubuntu\\home\\u\\night-runs');
});

test('check: gh not logged in inside WSL -> exit 5', () => {
  const r = sandbox({ STUB_GH_EXIT: '1' }).sh(['check']);
  assert.strictEqual(r.status, 5);
  assert.match(r.stderr, /gh/);
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
  assert.match(prefix, /^export CLAUDE_PLUGIN_ROOT=\/home\/u\/\.claude\/plugins\/cache\/bajzi-plugins\/bajzi\/1\.42\.0; cd \/mnt\/d\/proj;$/);
  assert.strictEqual(rest.join('\n'), step);
  assert.match(log, /ARGV:-d Ubuntu --cd C:\\stub\\.* -- bash -l -s/);
});

test('run with DISTRO, WSL_CWD and WSL_PLUGIN_ROOT in the env skips every lookup', () => {
  const s = sandbox({ DISTRO: 'Ubuntu', WSL_CWD: '/mnt/d/p', WSL_PLUGIN_ROOT: '/r/1.42.0' });
  assert.strictEqual(s.sh(['run'], 'true\n').status, 0);
  assert.strictEqual(s.log().split('\n').filter((l) => l.startsWith('ARGV:')).length, 1);
  assert.match(s.log(), /export CLAUDE_PLUGIN_ROOT=\/r\/1\.42\.0; cd \/mnt\/d\/p;/);
});

test('launch starts the hidden holder with the ps1 path, distro, ND and UntilEpoch = deadline + 7200', () => {
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const s = sandbox({ STUB_UNTIL: String(deadline + 7200) });
  const r = s.sh(['launch', ND]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /holder started/);
  assert.ok(r.stdout.includes(`${ND}/logs/hold.log`));
  const ps = s.log().split('\n').find((l) => l.startsWith('PS:'));
  assert.ok(ps, s.log());
  assert.match(ps, /Start-Process powershell\.exe -WindowStyle Hidden/);
  assert.ok(ps.includes('night-hold.ps1'));
  assert.ok(ps.includes("'-Distro','Ubuntu'"));
  assert.ok(ps.includes(`'-NightDir','${ND}'`));
  assert.ok(ps.includes(`'-UntilEpoch','${deadline + 7200}'`));
});

test('launch asks WSL for deadline+7200 from launch.sh and falls back to now+72h in the remote script', () => {
  const s = sandbox({ STUB_UNTIL: '1' });
  s.sh(['launch', ND]);
  const log = s.log();
  assert.ok(log.includes('--deadline'));
  assert.ok(log.includes('+7200'));
  assert.ok(log.includes('259200'));
  assert.ok(log.includes(`${ND}\n`));
});

test('not Git Bash (uname) or an unknown subcommand -> usage, exit 2', () => {
  assert.strictEqual(sandbox({}, 'Linux').sh(['pick']).status, 2);
  assert.strictEqual(sandbox().sh(['frobnicate']).status, 2);
  assert.strictEqual(sandbox().sh([]).status, 2);
});

test('night-hold.ps1 keeps the PC awake, starts launch.sh, polls the flock and caps at UntilEpoch', () => {
  const p = fs.readFileSync(path.join(DIR, 'night-hold.ps1'), 'utf8');
  assert.ok(p.includes('0x80000001'));
  assert.ok(p.includes('0x80000000'));
  assert.ok(p.includes('SetThreadExecutionState'));
  assert.match(p, /flock -n "\$NightDir\/run\.flock" true/);
  assert.ok(p.includes('$UntilEpoch'));
  assert.ok(p.includes('launch.sh'));
  assert.ok(p.includes('Start-Sleep -Seconds 60'));
  assert.ok(/^[\x00-\x7f]*$/.test(p) && !p.includes('\r'), 'ASCII only');
});

test('wsl-bridge.sh is ASCII only', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(fs.readFileSync(BRIDGE, 'utf8')));
});
