'use strict';
// kill-guard: denies by-name process kills (Bash and PowerShell), allows kills by PID and mere
// mentions. No test here runs a real kill command.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { NODE_DIR, runScript } = require('./helpers');
const { check, decide } = require('../kill-guard');

const input = (tool_name, command) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name, tool_input: { command } });

const DENY = [
  // taskkill by image name or filter, any case, any switch prefix
  'taskkill /F /IM node.exe',
  'taskkill //F //IM node.exe',
  'taskkill -im node.exe',
  'taskkill /im node.exe /t',
  'TASKKILL.EXE /Fi "IMAGENAME eq node.exe"',
  'C:\\Windows\\System32\\taskkill.exe /IM node.exe',
  // pkill / killall, any args
  'pkill node',
  'pkill -f "node server.js"',
  'killall node',
  'killall',
  // Stop-Process / spps / PowerShell kill with -Name or a prefix of it
  'Stop-Process -Name node',
  'Stop-Process -N node -Force',
  'stop-process -na node',
  'spps -Nam node',
  'kill -Name node',
  'Stop-Process -ProcessName node',
  // Get-Process by name piped into a kill
  'Get-Process node | Stop-Process',
  'Get-Process -Name node | Stop-Process -Force',
  'gps node | spps',
  'ps node | kill',
  'Get-Process | Where-Object Name -eq node | Stop-Process',
  '(Get-Process node).Kill()',
  'Get-Process -Name node | % { $_.Kill() }',
  '$p = gps node; $p.Kill()',
  'ps aux | grep node | awk \'{print $2}\' | xargs kill -9',
  // kill fed by pgrep / pidof
  'kill $(pgrep node)',
  'kill -9 `pidof node`',
  'pgrep node | xargs kill',
  'pidof node | xargs -r kill -9',
  // wmic / Win32_Process
  'wmic process where name="node.exe" delete',
  'wmic process where name="node.exe" call terminate',
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Invoke-CimMethod -MethodName Terminate',
  '(Get-WmiObject Win32_Process -Filter "Name=\'node.exe\'").Terminate()',
  // prefixes
  'sudo pkill node',
  'sudo -u root killall node',
  'nice -n 10 pkill node',
  'nohup pkill node',
  'timeout 5 pkill node',
  'env FOO=1 killall node',
  'env -i pkill node',
  'time -p pkill node',
  'rtk proxy pkill node',
  'npm test; taskkill /F /IM node.exe',
  'sudo -n pkill node',
  'sudo -k killall node',
  'sudo -s pkill node',
  'pgrep node | xargs -n 1 kill -9',
  'pgrep node | xargs -P 4 kill',
  'pidof node | xargs -I % kill %',
  'Get-Process node | % { Stop-Process -Id $_.Id }',
  'Get-Process node | % { Stop-Process $_ }',
  'Stop-Process -Id (Get-Process node).Id',
  'kill -ProcessName node',
  // shell keywords ahead of the command
  'if pgrep -x node >/dev/null; then pkill node; fi',
  'for i in 1 2; do killall node; done',
  'if true; then echo; else pkill node; fi',
  'else pkill node',
  '! pkill node',
  'while true; do pkill node; done',
  'if ! killall node; then echo; fi',
  // a command substitution inside double quotes
  'kill "$(pgrep node)"',
  'kill -9 "$(pidof node)"',
  'kill "`pidof node`"',
  'echo "it\'s $(pkill node)"',
  // a signal option's value is not a target
  'kill -s KILL $(pgrep node)',
  'kill -s TERM `pidof node`',
  'kill -n 9 $(pgrep node)',
  'kill --signal KILL $(pgrep node)',
  // nested shells
  'bash -c "pkill node"',
  'sh -c \'taskkill //F //IM node.exe\'',
  'cmd /c taskkill /IM node.exe',
  'cmd //c taskkill //IM node.exe',
  'powershell -Command "Get-Process node | Stop-Process"',
  'pwsh -c "Stop-Process -Name node"',
  'powershell.exe -NoProfile -Command "Stop-Process -Name node"',
];

const ALLOW = [
  'taskkill /PID 123 /F /T',
  'taskkill //PID 123 //F',
  'kill 123',
  'kill -9 123',
  'kill -n 9 123',
  'kill %1',
  'Stop-Process -Id 123',
  'Stop-Process -Id 123 -Force',
  'Get-Process -Id 123 | Stop-Process',
  'echo pkill',
  'grep -n taskkill file',
  'git commit -m "no taskkill /IM"',
  'rg killall',
  'echo "Stop-Process -Name node"',
  'Get-Process node',
  'ps aux | grep node',
  'pgrep node',
  'bash -c "kill 123"',
  'command -v pkill',
  'command -v killall',
  'node --test x.test.js',
  "kill '$(pgrep node)'",
  'kill "$(cat app.pid)"',
  'kill -s KILL 123',
  "echo '$(pkill node)'",
  'git commit -m "$(cat <<\'EOF\'\nStop-Process -Name and pkill/killall are denied\nEOF\n)"',
  'git commit -m "$(cat <<\'EOF\'\nAdded: denies `pkill` and `taskkill /IM`\nEOF\n)"',
  'git commit -m "deny \\`pkill node\\`"',
  '',
];

for (const tool of ['Bash', 'PowerShell']) {
  for (const cmd of DENY) {
    test(`${tool} denies: ${cmd}`, () => {
      const d = check(input(tool, cmd));
      assert.ok(d, cmd);
      assert.strictEqual(d.kind, 'deny');
      assert.strictEqual(d.rule, 'kill-guard');
    });
  }
  for (const cmd of ALLOW) {
    test(`${tool} allows: ${cmd}`, () => {
      assert.strictEqual(check(input(tool, cmd)), null, cmd);
    });
  }
}

// A backslash is literal in PowerShell (under Bash `\$` really escapes), so these deny there only.
for (const cmd of [
  'Write-Output "C:\\logs\\$(Stop-Process -Name node)"',
  'Set-Location "C:\\work\\"; Write-Output "it\'s $(Stop-Process -Name node)"',
]) {
  test(`PowerShell denies: ${cmd}`, () => {
    assert.ok(check(input('PowerShell', cmd)), cmd);
  });
}

test('other tools and malformed input are not checked', () => {
  assert.strictEqual(check(input('Read', 'pkill node')), null);
  assert.strictEqual(check(null), null);
  assert.strictEqual(decide({ tool_name: 'Bash' }), null);
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 42 } }), null);
});

test('deny text names the rule and tells the agent what to do instead', () => {
  const { reason } = check(input('Bash', 'taskkill //F //IM node.exe'));
  assert.match(reason, /^kill-guard: /);
  assert.match(reason, /stop only processes you started, by the PID you got when you started them/i);
  assert.match(reason, /a by-name kill also hits other sessions, MCP servers and running night runs/i);
  assert.match(reason, /if one is truly needed, ask the owner to run it/i);
  assert.match(reason, /pattern guard, not a shell parser/);
});

test('run directly, kill-guard.js emits the deny envelope and stays silent on an allow', () => {
  const script = path.join(NODE_DIR, 'kill-guard.js');
  const r = runScript(script, JSON.stringify(input('PowerShell', 'Stop-Process -Name node')));
  assert.strictEqual(r.code, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /^\[bajzi:kill-guard\] kill-guard: /);
  assert.strictEqual(runScript(script, JSON.stringify(input('Bash', 'kill 123'))).stdout, '');
  assert.strictEqual(runScript(script, 'not json').stdout, '');
});
