'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_DIR, tmpDir, runScript, p95 } = require('./helpers');
const rules = require('../lib/secret-rules');
const { decide } = require('../secret-guard');

const SCRIPT = path.join(NODE_DIR, 'secret-guard.js');
const EXTRA = ['*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'credentials.json'];
const read = file_path => ({ tool_name: 'Read', tool_input: { file_path } });
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const ps = command => ({ tool_name: 'PowerShell', tool_input: { command } });
const ruleOf = input => { const h = decide(input, EXTRA); return h ? h.rule : null; };

test('RF3: Windows and git forms of .env are denied with env-file', () => {
  assert.strictEqual(ruleOf(read('D:\\proj\\.ENV')), 'env-file');
  assert.strictEqual(ruleOf(bash('cat "./.env"')), 'env-file');
  assert.strictEqual(ruleOf(ps('Get-Content .\\.env.local')), 'env-file');
  assert.strictEqual(ruleOf(read('src/.env.production')), 'env-file');
  assert.strictEqual(ruleOf(bash('git show HEAD:.env')), 'env-file');
  assert.strictEqual(ruleOf(bash('git -C D:\\repo show HEAD:.env')), 'env-file');
});

test('RF3: .env.example and .env.sample are allowed', () => {
  for (const p of ['.env.example', '.env.sample', 'D:\\proj\\.env.template', 'cfg/.env.dist', '.env.local.example']) {
    assert.strictEqual(ruleOf(read(p)), null, p);
  }
  assert.strictEqual(ruleOf(bash('cat .env.example')), null);
  assert.strictEqual(ruleOf(bash('cp .env.example .env')), null);
  assert.strictEqual(ruleOf(bash('cat .env.example > .env')), null);
});

test('shell readers of protected files are denied (bash and PowerShell)', () => {
  const env = [
    bash('source .env'), bash('. ./.env'), bash('grep KEY .env'), bash('rg KEY .env.local'), bash('sed -n 1p .env'),
    bash('awk 1 .env'), bash('head -1 .env'), bash('tail .env'), bash('less .env'), bash('more .env'),
    bash('echo ok && cat .env'), bash('ls | cat .env'), bash('wc -l < .env'), bash('sudo cat /app/.env'),
    bash('FOO=1 cat .env'), bash('grep -r KEY --include=.env .'), bash('base64 .env'),
    bash('python -c "print(open(\'.env\').read())"'), bash('node -e "require(\'fs\').readFileSync(\'.env\')"'),
    bash("bash -c 'cat .env'"), bash('/usr/bin/cat .env'),
    ps('type .env'), ps('gc .env'), ps('Select-String -Path .env -Pattern KEY'), ps('Get-Content -Path:.env'),
    ps("[IO.File]::ReadAllText('.env')"), ps('cat.exe .env'),
  ];
  for (const i of env) assert.strictEqual(ruleOf(i), 'env-file', i.tool_input.command);
  assert.strictEqual(ruleOf(ps('Import-Csv .secrets')), 'secrets-file');
});

test('manifest patterns fire with their own rule id', () => {
  assert.strictEqual(ruleOf(read('C:\\Users\\a\\.ssh\\id_rsa')), 'pattern:id_rsa*');
  assert.strictEqual(ruleOf(read('certs/server.PEM')), 'pattern:*.pem');
  assert.strictEqual(ruleOf(read('~/.ssh/id_ed25519')), 'pattern:id_ed25519*');
  assert.strictEqual(ruleOf(bash('cat credentials.json')), 'pattern:credentials.json');
  assert.strictEqual(ruleOf(read('.secrets')), 'secrets-file');
});

test('Grep and Glob: protected path, glob and pattern', () => {
  assert.strictEqual(ruleOf({ tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '.env' } }), 'env-file');
  assert.strictEqual(ruleOf({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env*' } }), 'env-file');
  assert.strictEqual(ruleOf({ tool_name: 'Glob', tool_input: { pattern: '**/*.key' } }), 'pattern:*.key');
  assert.strictEqual(ruleOf({ tool_name: 'Glob', tool_input: { pattern: '**/.env*' } }), 'env-file');
  assert.strictEqual(ruleOf({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }), null);
  assert.strictEqual(ruleOf({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.md', path: 'src' } }), null);
});

test('non-reads and look-alikes are allowed', () => {
  for (const i of [bash('ls -la .env'), bash('echo .env'), bash('git status'), bash('git add .env.example'),
    bash('rm -f .env.bak'), bash('cat README.md'), read('src/environment.ts'), read('.envrc'), read('docs/env.md'),
    bash('f=.env; echo $f'), { tool_name: 'Write', tool_input: { file_path: '.env' } }]) {
    assert.strictEqual(ruleOf(i), null, JSON.stringify(i));
  }
});

// Fix round 1 (review I1, I2, M1). One assertion per form, each naming the rule id.
test('I1: a glob arg that names a protected file is refused', () => {
  assert.strictEqual(ruleOf(bash('cat .env*')), 'env-file');
  assert.strictEqual(ruleOf(bash('head certs/*.pem')), 'pattern:*.pem');
  assert.strictEqual(ruleOf(bash('wc -l < .env*')), 'env-file');
  assert.strictEqual(ruleOf(bash('cat *.md')), null);
});

test('I1: PowerShell comma arrays are split', () => {
  assert.strictEqual(ruleOf(ps('gc .env, README.md')), 'env-file');
  assert.strictEqual(ruleOf(ps('Get-Content README.md,.secrets')), 'secrets-file');
  assert.strictEqual(ruleOf(ps('gc README.md, .env.example')), null);
});

test('I1: brace expansion in shell args is expanded, not a segment break', () => {
  assert.strictEqual(ruleOf(bash('cat {.env,x}')), 'env-file');
  assert.strictEqual(ruleOf(bash('cat cfg/{a,.secrets}')), 'secrets-file');
  assert.strictEqual(ruleOf(bash('cat {README,CHANGELOG}.md')), null);
  assert.deepStrictEqual(rules.segments('cat {.env,x}'), [['cat', '{.env,x}']]);
  assert.deepStrictEqual(rules.segments('if x { gc .env }'), [['if', 'x'], ['gc', '.env']]);
});

test('I1: Grep/Glob brace lists are expanded', () => {
  assert.strictEqual(ruleOf({ tool_name: 'Grep', tool_input: { pattern: 'K', glob: '{.env,.secrets}' } }), 'env-file');
  assert.strictEqual(ruleOf({ tool_name: 'Grep', tool_input: { pattern: 'K', glob: '{README.md,.secrets}' } }), 'secrets-file');
  assert.strictEqual(ruleOf({ tool_name: 'Glob', tool_input: { pattern: '**/*.{pem,key}' } }), 'pattern:*.pem');
  assert.strictEqual(ruleOf({ tool_name: 'Glob', tool_input: { pattern: '**/*.{ts,md}' } }), null);
});

test('I2: rtk read/grep and rtk proxy/err/test unwrap to the inner command', () => {
  assert.strictEqual(ruleOf(bash('rtk read .env')), 'env-file');
  assert.strictEqual(ruleOf(bash('rtk read -l aggressive id_rsa')), 'pattern:id_rsa*');
  assert.strictEqual(ruleOf(bash('rtk grep KEY .env')), 'env-file');
  assert.strictEqual(ruleOf(bash('rtk proxy cat .env')), 'env-file');
  assert.strictEqual(ruleOf(bash('rtk err cat .secrets')), 'secrets-file');
  assert.strictEqual(ruleOf(bash('rtk read README.md')), null);
  assert.strictEqual(ruleOf(bash('read -r x .env')), null);   // plain `read` is not a file reader
});

test('M1: extra readers, timeout/xargs wrappers, cmd interpreter', () => {
  for (const c of ['diff .env .env.example', 'sort .env', 'cut -d= -f2 .env', 'jq . .env', 'hexdump -C .env',
    'timeout 5 cat .env', 'timeout -s KILL 5s cat .env', 'xargs -n 1 cat .env', 'cmd /c type .env']) {
    assert.strictEqual(ruleOf(bash(c)), 'env-file', c);
  }
  assert.strictEqual(ruleOf(ps('Format-Hex .env')), 'env-file');
  assert.strictEqual(ruleOf(bash('timeout 5 ls .env')), null);
});

test('M1: a protected name piped into a reader is refused', () => {
  assert.strictEqual(ruleOf(ps('Get-ChildItem .env | Get-Content')), 'env-file');
  assert.strictEqual(ruleOf(bash('echo .secrets | xargs cat')), 'secrets-file');
  assert.strictEqual(ruleOf(bash('echo .env || cat README.md')), null);   // || is not a pipe
  assert.strictEqual(ruleOf(bash('echo .env | wc -l')), null);
  // the pipe rule fires only when the right-hand side reads PATHS from stdin
  assert.strictEqual(ruleOf(bash('echo .env | xargs cat')), 'env-file');
  assert.strictEqual(ruleOf(bash('find . -name "*.pem" | xargs -n1 head')), 'pattern:*.pem');
  assert.strictEqual(ruleOf(ps('Get-ChildItem .env | Select-String KEY')), 'env-file');
  assert.strictEqual(ruleOf(ps('Get-ChildItem .env | gc')), 'env-file');
  assert.strictEqual(ruleOf(ps('ls .env* | cat')), 'env-file');   // PowerShell cat = Get-Content
  // I-1: any downstream stage, not just the next one
  for (const c of ['find . -name .env | head -1 | xargs cat', 'git ls-files .env | head | xargs cat', 'ls .env | sort | xargs cat']) {
    assert.strictEqual(ruleOf(bash(c)), 'env-file', c);
  }
  assert.strictEqual(ruleOf(ps('gci .env | sort | gc')), 'env-file');
  assert.strictEqual(ruleOf(bash('echo .env; ls | xargs cat')), null);   // the walk stops at a non-pipe separator
});

test('T4-m1: listing commands piped into a data reader are allowed', () => {
  for (const c of ['find . -name "*.env*" | sort', 'find -name "*.pem" | head', 'ls .env* | head',
    'git check-ignore .env | cat']) {
    assert.strictEqual(ruleOf(bash(c)), null, c);
  }
});

test('segments: quotes group, backslashes stay literal, separators split', () => {
  assert.deepStrictEqual(rules.segments('cat "a b" && type .\\x;echo y|z'), [['cat', 'a b'], ['type', '.\\x'], ['echo', 'y'], ['z']]);
  assert.deepStrictEqual(rules.segments('wc -l < .env > out'), [['wc', '-l', '<', '.env', '>', 'out']]);
});

test('loadExtraPatterns reads manifest secret_patterns; missing manifest = []', () => {
  const root = tmpDir('bajzi-root-');
  assert.deepStrictEqual(rules.loadExtraPatterns(root), []);
  fs.mkdirSync(path.join(root, 'skills', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'setup', 'manifest.json'), JSON.stringify({ secret_patterns: ['*.kdbx', 5] }));
  assert.deepStrictEqual(rules.loadExtraPatterns(root), ['*.kdbx']);
});

test('the real manifest carries the initial secret_patterns', () => {
  const m = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '..', '..', 'skills', 'setup', 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(m.secret_patterns, EXTRA);
});

test('end to end: deny names the rule and suggests the .example file', () => {
  const r = runScript(SCRIPT, JSON.stringify(read('.env')));
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /^\[bajzi:env-file\] /);
  assert.match(o.permissionDecisionReason, /\.env\.example/);
  assert.match(o.permissionDecisionReason, /pattern guard, not a shell parser/);
});

test('end to end: CLAUDE_PLUGIN_ROOT manifest patterns are honoured', () => {
  const root = tmpDir('bajzi-root-');
  fs.mkdirSync(path.join(root, 'skills', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'setup', 'manifest.json'), JSON.stringify({ secret_patterns: ['*.kdbx'] }));
  const r = runScript(SCRIPT, JSON.stringify(read('vault.kdbx')), { CLAUDE_PLUGIN_ROOT: root });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /^\[bajzi:pattern:\*\.kdbx\] /);
  const dflt = runScript(SCRIPT, JSON.stringify(read('id_rsa')));   // no env: the plugin's own manifest
  assert.match(JSON.parse(dflt.stdout).hookSpecificOutput.permissionDecisionReason, /^\[bajzi:pattern:id_rsa\*\] /);
});

test('RF2: secret guard survives bad stdin', () => {
  for (const stdin of ['', 'not json', '{}', '{"tool_name":"Read"}', '{"tool_name":"Read","tool_input":null}',
    '{"tool_name":"Read","tool_input":{"file_path":5}}', '{"tool_name":"Bash","tool_input":{"command":["cat",".env"]}}']) {
    const r = runScript(SCRIPT, stdin);
    assert.strictEqual(r.code, 0, stdin);
    assert.strictEqual(r.stdout, '', stdin);
    assert.strictEqual(r.stderr, '', stdin);
  }
  const bom = runScript(SCRIPT, '\ufeff' + JSON.stringify(read('.env')));
  assert.match(JSON.parse(bom.stdout).hookSpecificOutput.permissionDecisionReason, /^\[bajzi:env-file\]/);
});

test('hooks.json wires the secret guard on Read|Grep|Glob|Bash|PowerShell', () => {
  const h = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '..', 'hooks.json'), 'utf8')).hooks;
  const e = h.PreToolUse.find(x => x.hooks.some(k => k.command === 'node "${CLAUDE_PLUGIN_ROOT}/hooks/node/secret-guard.js"'));
  assert.ok(e);
  assert.strictEqual(e.matcher, 'Read|Grep|Glob|Bash|PowerShell');
  assert.strictEqual(e.hooks[0].timeout, 5);
});

// Best of 3 batches, as in context-guard.test.js: `node --test` runs the test FILES in parallel,
// so one batch can measure CPU contention rather than the guard.
test('p95 of 20 runs < 100 ms, best of 3 batches', () => {
  const stdin = JSON.stringify(bash('git status && cat README.md'));
  const batches = [];
  for (let b = 0; b < 3 && !(batches.length && Math.min(...batches) < 100); b++) {
    const ms = [];
    for (let i = 0; i < 20; i++) ms.push(runScript(SCRIPT, stdin).ms);
    batches.push(p95(ms));
  }
  assert.ok(Math.min(...batches) < 100, `p95 per batch ${batches.map(x => x.toFixed(1)).join(' / ')} ms`);
});
