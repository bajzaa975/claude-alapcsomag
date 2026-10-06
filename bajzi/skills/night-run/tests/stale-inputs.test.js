'use strict';
// nr-stale-inputs: night-run planning never renders from stale inputs.
// launch.sh is rendered on every plan from templates/launch.sh.tmpl (RUN_SH = the current plugin's run.sh),
// BASE is refreshed from a fresh origin fetch before anything is read from it, a merged dependency forces a
// re-render, and REQUIRED_CHECK says which name the night matches. Phrase assertions, no whole-file snapshot.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8').replace(/\r\n/g, '\n');
const LAUNCH = read('templates', 'launch.sh.tmpl');
const SKILL = read('SKILL.md');
const CONFIG = read('templates', 'config.env.tmpl');
const RULES = read('templates', 'NIGHT-RULES.md.tmpl');
const flat = (s) => s.replace(/\s+/g, ' ');
const has = (hay, phrase) => assert.ok(hay.includes(phrase), `missing: ${phrase}`);
const phase = (from, to) => {
  const a = SKILL.indexOf(from), b = SKILL.indexOf(to);
  assert.ok(a >= 0 && b > a, `${from} .. ${to} present in order`);
  return SKILL.slice(a, b);
};
const CMD = 'gh run list -R <owner>/<repo> --limit 3 --json workflowName,name';

test('launch.sh.tmpl: flock refusal, backup abort, detached start with the two placeholders', () => {
  has(LAUNCH, 'set -u');
  has(LAUNCH, 'cd "$BASE" || ');
  has(LAUNCH, 'exec 9>>"$ND/run.flock"');
  has(LAUNCH, 'if ! flock -n 9; then echo "A runner is ALREADY running (run.lock: $(cat "$ND/run.lock"');
  has(LAUNCH, '$DEST.pre-night-$(date +%F-%H%M%S)');
  has(LAUNCH, 'BACKUP FAILED — nothing was overwritten');
  has(LAUNCH, 'cp "$ND/settings.local.json" "$DEST"');
  has(LAUNCH, 'export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000');
  has(LAUNCH, 'setsid nohup bash "{{RUN_SH}}" --config "$ND/config.env" --deadline "{{DEADLINE}}" --date "{{RUN_DATE}}"');
  has(LAUNCH, '>> "$ND/logs/console.log" 2>&1 </dev/null &');
  has(LAUNCH, 'tail -4 "$ND/logs/runner.log"');
});

test('launch.sh.tmpl: the flock check comes before the settings install, which comes before the start', () => {
  const at = (s) => { const i = LAUNCH.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('flock -n 9') < at('BACKUP FAILED') && at('BACKUP FAILED') < at('cp "$ND/settings.local.json"')
    && at('cp "$ND/settings.local.json"') < at('setsid nohup'));
});

test('launch.sh.tmpl: no hard-coded plugin cache version path, no other absolute run.sh', () => {
  assert.ok(!/\/bajzi\/1\./.test(LAUNCH), 'literal /bajzi/1.x cache path');
  assert.ok(!/plugins\/cache/.test(LAUNCH), 'literal plugin cache path');
  const code = LAUNCH.split('\n').filter((l) => !l.startsWith('#')).join('\n');
  const runs = code.match(/[^\s"']*run\.sh/g) || [];
  assert.ok(runs.every((r) => r === '{{RUN_SH}}' || r === 'run.sh'), `unexpected run.sh paths: ${runs}`);
});

const render = (over = {}) => {
  const v = { PROJECT: 'proj', BASE: '/tmp/b', NIGHT_DIR: '/tmp/n', RUN_SH: '/plug/skills/night-run/run.sh', DEADLINE: '04:30', RUN_DATE: '2026-10-04', ...over };
  return Object.entries(v).reduce((s, [k, x]) => s.split(`{{${k}}}`).join(x), LAUNCH);
};

test('launch.sh.tmpl rendered with dummy values: no placeholder left and `bash -n` is clean', (t) => {
  const out = render();
  assert.deepStrictEqual(out.match(/{{[A-Za-z_0-9]+}}/g), null);
  has(out, 'setsid nohup bash "/plug/skills/night-run/run.sh" --config "$ND/config.env" --deadline "04:30" --date "2026-10-04"');
  const r = spawnSync('bash', ['-n'], { input: out, encoding: 'utf8' });   // stdin, so Git Bash and WSL bash both read it
  if (r.error) return t.skip(`no bash: ${r.error.code}`);
  assert.strictEqual(r.status, 0, `bash -n: ${r.stderr}`);
});

test('SKILL.md PHASE C: launch.sh is rendered on every plan, RUN_SH resolved from the current plugin root', () => {
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, '`launch.sh`, rendered from `templates/launch.sh.tmpl` into `<NIGHT_DIR>/launch.sh` on EVERY plan, overwriting an old one');
  has(c, 'RUN_SH="${CLAUDE_PLUGIN_ROOT%/}/skills/night-run/run.sh"');
  has(c, 'never typed from memory, never copied from an earlier launch.sh and never the path of another plugin version');
  has(c, '[ -f "$got" ] || echo "LAUNCH.SH RUN_SH MISSING: $got"');
  has(c, '[ "$got" = "$RUN_SH" ] || echo "LAUNCH.SH RUN_SH STALE: ');
  has(c, 'bash -n "$L"');
  has(c, 'the same check runs again at the gate');
});

test('SKILL.md PHASE A: fresh fetch, clean tracked tree, then a NEW night/base branch, all before any BASE file is rendered', () => {
  const a = phase('## PHASE A', '## PHASE B');
  has(flat(a), 'in THIS phase (an earlier fetch, from another session or an earlier phase, does not count)');
  has(a, '/usr/bin/git -C "<BASE>" fetch origin <BASE_BRANCH>');
  has(a, '/usr/bin/git -C "<BASE>" status --porcelain --untracked-files=no');
  has(flat(a), 'BLOCKER `BASE tracked tree is dirty');
  has(a, 'checkout --no-track -b "night/base-$STAMP" "origin/<BASE_BRANCH>"');
  has(a, 'STAMP=$(date +%Y-%m-%d-%H%M)');
  has(a, '"<NIGHT_DIR>/render-base.sha"');
  // the existing BASE rules stay
  has(flat(a), '`BASE` is an absolute FILESYSTEM PATH');
  has(flat(a), 'is never a deployed tree or a `REPO` coordinate');
  const fetch = SKILL.indexOf('fetch origin <BASE_BRANCH>');
  const branch = SKILL.indexOf('checkout --no-track -b "night/base-$STAMP"');
  const status = SKILL.indexOf('status --porcelain --untracked-files=no');
  const nightRules = SKILL.indexOf("src = src.replace('{{NIGHT_RULES}}', body)");
  const rulesCheck = SKILL.indexOf('<BASE>/docs/NIGHT-RULES.md <<');
  assert.ok(fetch >= 0 && status > fetch && branch > status, 'fetch, then the clean check, then the branch');
  assert.ok(nightRules > branch && rulesCheck > branch, 'the NIGHT_RULES render and the rules check come after the branch');
});

test('SKILL.md PHASE C: a merge during planning forces fetch, fast-forward and a full re-render', () => {
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, 'a plan never outlives the base it was rendered from');
  has(c, 'MERGED while you are planning');
  has(c, '/usr/bin/git -C "<BASE>" merge --ff-only "origin/<BASE_BRANCH>"');
  has(c, 'starts with `night/base-`');
  has(c, 'RE-RENDER everything that read BASE or the plugin: `BRIEF.md`');
  has(c, '`launch.sh` (with the check above)');
});

test('SKILL.md PHASE D: the gate prints the rendered SHA and refuses on a newer origin', () => {
  const d = flat(phase('## PHASE D', '## PHASE E'));
  has(d, 'Rendered from origin/<BASE_BRANCH> @ <SHA>');
  has(d, 'ls-remote origin "refs/heads/<BASE_BRANCH>"');
  has(d, 'the gate REFUSES (`STALE RENDER: rendered <SHA>, origin now <SHA2>`)');
  has(d, 'launch.sh` was rendered in this plan');
});

test('SKILL.md PHASE E: the launch block is `bash <NIGHT_DIR>/launch.sh` from a plain terminal outside Claude Code', () => {
  const e = flat(phase('## PHASE E', '## PHASE F'));
  has(e, '```bash bash <NIGHT_DIR>/launch.sh ```');
  has(e, 'a plain **bash** terminal outside Claude Code — not the Claude prompt, not `!`');
  assert.ok(!e.includes('setsid nohup bash <absolute path of run.sh>'), 'the inline launch line is gone');
});

test('REQUIRED_CHECK: PHASE A checks the configured value against the workflow run names', () => {
  const a = flat(phase('## PHASE A', '## PHASE B'));
  has(a, 'the NAME OF THE WORKFLOW RUN as `gh run list` shows it');
  has(a, 'branch-protection check or job name');
  has(a, '--json workflowName,name --jq \'.[].workflowName\'');
  has(a, 'grep -qxF -- "$REQUIRED_CHECK"');
  has(a, "BLOCKER: REQUIRED_CHECK '$REQUIRED_CHECK' is not a workflow run name; gh shows: ");
});

test('config.env.tmpl and NIGHT-RULES.md.tmpl say which REQUIRED_CHECK name the night needs', () => {
  const c = CONFIG.slice(CONFIG.indexOf('# The NAME of the CI check'), CONFIG.indexOf('REQUIRED_CHECK="<name'));
  has(c, CMD);
  has(c, "NOT the branch-protection check/job");
  has(c, 'workflow file');
  const sec5 = RULES.slice(RULES.indexOf('## 5. CI facts'), RULES.indexOf('## 6.'));
  has(sec5, '`gh run list` shows it');
  has(sec5, 'NOT the branch-protection');
  has(flat(sec5), CMD);
});

test('PHASE A: no local-BASE_BRANCH behind check; REQUIRED_CHECK snippet loads config.env itself', () => {
  const a = flat(phase('## PHASE A', '## PHASE B'));
  assert.ok(!a.includes('rev-list --left-right --count <BASE_BRANCH>...origin/<BASE_BRANCH>'), 'stale behind-check');
  const snip = SKILL.slice(SKILL.indexOf('gh run list -R "<REPO>" --event pull_request --limit 10 --json workflowName,name'));
  assert.ok(snip.indexOf('. ~/night-runs/<project>/config.env') >= 0
    && snip.indexOf('. ~/night-runs/<project>/config.env') < snip.indexOf('grep -qxF -- "$REQUIRED_CHECK"'), 'config.env loaded in the snippet');
});

test('PHASE A deletes earlier night/base-* branches in the step that creates the new one', () => {
  const a = flat(phase('## PHASE A', '## PHASE B'));
  has(a, "for-each-ref --format='%(refname:short)' 'refs/heads/night/base-*'");
  has(a, 'branch -D "$b"');
  assert.ok(a.indexOf('checkout --no-track -b "night/base-$STAMP"') < a.indexOf('branch -D "$b"'));
});

test("launch.sh pins the run's own --date: SKILL.md PHASE C renders {{RUN_DATE}} into it", () => {
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, "('DEADLINE', deadline), ('RUN_DATE', run_date)");
  has(c, 'tmpl, out, run_sh, project, base, night, deadline, run_date = sys.argv[1:9]');
  has(c, '"<DEADLINE>" "<RUN_DATE>"');
});

test('WATCHER-BRIEF LAUNCH_LINE is the runner-only command, not launch.sh', () => {
  const s = flat(SKILL);
  has(s, '`{{LAUNCH_LINE}}` = the runner-only command (`');
  assert.ok(!s.includes('`{{LAUNCH_LINE}}` = the PHASE E launch'), 'launch.sh as LAUNCH_LINE');
  const line = s.split('`{{LAUNCH_LINE}}` = the runner-only command (`')[1].split('`')[0];
  for (const p of ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000', 'setsid nohup bash', '--config', '--deadline', '--date "<RUN_DATE>"',
    '</dev/null', '>> "<NIGHT_DIR>/logs/console.log" 2>&1']) has(line, p);
  assert.ok(line.endsWith(' &'), 'detaches with trailing &');
  assert.ok(!line.includes('launch.sh'), 'launch.sh in the line');
});

test('SUPERVISE-PROMPT relaunches with the same runner-only LAUNCH_LINE as WATCHER-BRIEF, never launch.sh', () => {
  const sup = read('templates', 'SUPERVISE-PROMPT.md.tmpl');
  const watch = read('templates', 'WATCHER-BRIEF.md.tmpl');
  const c = flat(phase('## PHASE C', '## PHASE D'));
  const bullet = c.split('- `SUPERVISE-PROMPT.md`, rendered from')[1].split('- `BRIEF.md`, rendered from')[0];
  has(bullet, "`{{LAUNCH_LINE}}` = the same runner-only command as WATCHER-BRIEF.md's `{{LAUNCH_LINE}}`");
  const relaunch = flat(sup).split('- **Relaunch**')[1].split('ONLY when ALL hold')[0];
  has(relaunch, '`{{LAUNCH_LINE}}`');
  assert.ok(!sup.includes('bash {{NIGHT_DIR}}/launch.sh'), 'supervisor relaunch through launch.sh');
  // Rendered with the one LAUNCH_LINE value PHASE C defines, both prompts carry the identical line.
  const line = flat(SKILL).split('`{{LAUNCH_LINE}}` = the runner-only command (`')[1].split('`')[0];
  const r = (t) => t.split('{{LAUNCH_LINE}}').join(line);
  has(flat(r(sup)).split('- **Relaunch**')[1].split('ONLY when ALL hold')[0], line);
  has(r(watch), line);
});

// ---------- nr-glm-night: nights at L2/L3 run on GLM ----------
const BRIEF = read('templates', 'BRIEF.md.tmpl');

test('PHASE C config.env render at L2/L3: CLAUDE_BIN glm, MODEL opus, triage and supervisor off', () => {
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, 'At L2/L3 (`glm`/`tight`, the level PHASE A step 8 resolved)');
  has(c, '`CLAUDE_BIN="glm"`');
  has(c, '`MODEL="opus"`');
  has(c, 'cc-router maps the opus alias to glm_orchestrator_model');
  has(c, '`WATCH_TRIAGE="0"`');
  has(c, '`SUPERVISE="0"`');
  has(c, '# off: triage and supervisor run on Claude only (supervise.sh scrubs the router env), a GLM night runs without them');
});

test('PHASE C BRIEF render: GLM delegation variant at L2/L3, Claude-tier variant at L0/L1', () => {
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, '`{{DELEGATION_TABLE}}` and `{{DELEGATION_MODELS}}`');
  has(c, 'GLM variant at L2/L3, Claude-tier variant at L0/L1');
});

test('PHASE D gate at L2/L3: two BLOCKER greps and the 06:00 UTC deadline check', () => {
  const d = flat(phase('## PHASE D', '## PHASE E'));
  has(d, "`grep -c 'glm -p' <NIGHT_DIR>/BRIEF.md`");
  has(d, "`grep -qx 'CLAUDE_BIN=\"glm\"' <NIGHT_DIR>/config.env`");
  has(d, 'BLOCKER');
  has(d, 'exit 75');
  has(d, 'the deadline in UTC and in local time');
});

test('BRIEF.md.tmpl: GLM variant names glm -p, L0/L1 variant keeps Haiku/Sonnet, body uses the placeholders', () => {
  const head = BRIEF.slice(0, BRIEF.indexOf('\n-->'));
  const g = flat(head.split('DELEGATION VARIANT L2/L3')[1].split('DELEGATION VARIANT L0/L1')[0]);
  const l = flat(head.split('DELEGATION VARIANT L0/L1')[1]);
  has(g, 'glm -p --model haiku');
  has(g, '| implement a slice, TDD | `glm -p`');
  has(g, '{{BASE}}/runtime/review-queue/<id>.md');
  has(g, 'nothing is merged unattended');
  assert.ok(!/Haiku|Sonnet/.test(g), 'GLM variant names no Claude tier');
  has(l, '| locate code, explore layout | Haiku');
  has(l, '| write a document > 100 lines | Sonnet');
  has(l, 'Sonnet for documents over 100 lines; Haiku for exploration');
  const body = BRIEF.slice(BRIEF.indexOf('\n-->'));
  assert.strictEqual(body.split('{{DELEGATION_TABLE}}').length, 2);
  assert.strictEqual(body.split('{{DELEGATION_MODELS}}').length, 2);
  assert.ok(!/\| Haiku /.test(body), 'no hard-coded Haiku row left in the body');
});

test('config.env.tmpl documents CLAUDE_BIN next to MODEL', () => {
  const i = CONFIG.indexOf('MODEL="<reviewer allow-list entry [0]>"');
  const near = flat(CONFIG.slice(i, i + 900));
  has(near, '# CLAUDE_BIN="claude"');
  has(near, 'glm at L2/L3, rendered by PHASE C');
});

// ---- nr-glm-night round 1 ----
const variant = (name, level) => {   // the documented rule: lines strictly between the two fence lines, joined by \n, no trailing newline
  const head = BRIEF.slice(0, BRIEF.indexOf('\n-->'));
  const part = level === 'glm' ? head.split('DELEGATION VARIANT L2/L3')[1].split('DELEGATION VARIANT L0/L1')[0] : head.split('DELEGATION VARIANT L0/L1')[1];
  const lines = part.split('\n');
  const at = lines.findIndex((l) => l.trim() === `${name}:`);
  assert.ok(at >= 0, name);
  const o = at + 1, c = lines.findIndex((l, i) => i > o && /^\s*```\s*$/.test(l));
  assert.ok(/^\s*```\s*$/.test(lines[o]) && c > o, 'fenced');
  return lines.slice(o + 1, c).join('\n');
};
const GLM_TABLE = variant('DELEGATION_TABLE', 'glm');
const GLM_MODELS = variant('DELEGATION_MODELS', 'glm');

test('F1/F8 PHASE C sets the four config.env keys at EVERY level: replace an uncommented line or append, idempotent', () => {
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, 'setting four keys at EVERY level');
  has(c, 'replace its uncommented line when there is one, or append one when there is none');
  has(c, 'never a second line for a key, so a re-render is idempotent');
  has(c, 'Write the `# off:` line once');
  has(c, '`CLAUDE_BIN="claude"` and `MODEL="<reviewer allow-list entry [0]>"`');
  has(c, 'delete the `WATCH_TRIAGE="0"` / `SUPERVISE="0"` lines and the `# off:` line');
  assert.ok(!c.includes('At L0/L1 config.env is left exactly as it is'));
});

test('F1 PHASE D at L0/L1 refuses a config.env that still holds CLAUDE_BIN="glm"', () => {
  const d = flat(phase('## PHASE D', '## PHASE E'));
  has(d, 'At L0/L1 only');
  has(d, "BLOCKER when `grep -qx 'CLAUDE_BIN=\"glm\"' <NIGHT_DIR>/config.env` succeeds");
});

test('F2 GLM variant overrides section 7 too; L2/L3 settings deny gh pr merge and the gate checks it', () => {
  has(flat(GLM_TABLE), 'overrides sections 4, 5 and 7');
  const c = flat(phase('## PHASE C', '## PHASE D'));
  has(c, '"Bash(gh pr merge:*)", "Bash(*gh pr merge*)"');
  has(c, 'strip every `gh pr merge` allow rule');
  const d = flat(phase('## PHASE D', '## PHASE E'));
  has(d, '`Bash(*gh pr merge*)` is in `permissions.deny` of `<NIGHT_DIR>/settings.local.json`');
  has(d, 'no `gh pr merge` rule is left in `permissions.allow`');
});

test('F3 GLM variant: absolute queue file under BASE with the rq header and status line; PHASE F lists open items', () => {
  const g = flat(GLM_TABLE);
  has(g, '{{BASE}}/runtime/review-queue/<id>.md');
  has(g, 'never inside `{{NIGHT_DIR}}/wt/<id>/`');
  for (const h of ['# Review queue: <id>', 'status: open', 'branch:', 'sprint: <id>', 'files:', '## Evidence']) has(g, h);
  assert.ok(!g.includes('$SAVER_QUEUE_FILE'));
  const f = flat(SKILL.slice(SKILL.indexOf('## PHASE F')));
  has(f, "grep -lE '^status:[ \\t]*(open|pending)' <BASE>/runtime/review-queue/*.md");
  has(f, 'no ledger line');
});

test('F4 GLM variant: the story ends with a RESULT line that is valid under the section 9 grammar', () => {
  const body = BRIEF.slice(BRIEF.indexOf('\n-->'));
  const gram = body.match(/^ {3}RESULT <id> <([a-z|]+)> PR#<n or -> review=<([a-z|]+)> rounds=<n> reason=<([a-z|-]+)>$/m);
  assert.ok(gram, 'grammar line');
  const [states, reviews, reasons] = gram.slice(1).map((x) => x.split('|'));
  const m = flat(GLM_TABLE).match(/RESULT <id> (\S+) PR#<n or -> review=([a-z]+) rounds=0 reason=([a-z-]+)/);
  assert.ok(m, 'GLM RESULT line');
  const [, st, rv, rs] = m;
  assert.ok(states.includes(st) && reviews.includes(rv) && (reasons.includes(rs) || rs === '-'), 'tokens in grammar');
  assert.ok(!(['merged', 'open'].includes(st) && rv === 'parked'), 'no contradiction');
  assert.ok(!(st === 'parked' && rs === '-'), 'parked carries a real reason');
  assert.ok(!/BUILT/.test(GLM_TABLE), 'no BUILT token');
});

test('F5 PHASE D at L2/L3: launch-to-deadline interval must not overlap any 06:00-10:00 UTC window', () => {
  const d = flat(phase('## PHASE D', '## PHASE E'));
  has(d, 'launch-to-deadline interval overlaps any 06:00-10:00 UTC window');
  has(d, 'on any day of a multi-day run');
  const blk = phase('## PHASE D', '## PHASE E').match(/```bash\n\s*(L=\$\(date -u[\s\S]*?)```/);
  assert.ok(blk, 'peak check script');
  const run = (L, D) => spawnSync('bash', ['-c', blk[1].replace(/^L=.*$/m, `L=${L}; D=${D}`)], { encoding: 'utf8' });
  const t = (s) => Date.parse(s) / 1000;
  const r0 = run(t('2026-10-06T00:00:00Z'), t('2026-10-06T05:00:00Z'));
  if (r0.error) return;
  assert.strictEqual(r0.stdout, '', 'night before the window: clean');
  assert.match(run(t('2026-10-06T22:00:00Z'), t('2026-10-07T07:00:00Z')).stdout, /BLOCKER/);
  assert.match(run(t('2026-10-06T22:00:00Z'), t('2026-10-08T05:00:00Z')).stdout, /BLOCKER/);   // multi-day crossing a window
  assert.match(run(t('2026-10-06T08:00:00Z'), t('2026-10-06T12:00:00Z')).stdout, /BLOCKER/);   // launch inside the window
  assert.strictEqual(run(t('2026-10-06T10:00:00Z'), t('2026-10-07T05:59:00Z')).stdout, '');
});

test('F6 L0/L1 variant extracted by the documented rule reproduces the 1.15.2 text around both placeholders', () => {
  has(flat(phase('## PHASE C', '## PHASE D')), "the lines strictly between the two fence lines, joined with a single newline, no trailing newline, and the closing fence's indent is not part of it");
  const body = BRIEF.slice(BRIEF.indexOf('\n-->'))
    .replace('{{DELEGATION_TABLE}}', variant('DELEGATION_TABLE', 'l0'))
    .replace('{{DELEGATION_MODELS}}', variant('DELEGATION_MODELS', 'l0'));
  has(body, [
    '| work                          | model        | must return                                |',
    '|-------------------------------|--------------|--------------------------------------------|',
    '| locate code, explore layout   | Haiku        | paths plus <= 10 lines, no file contents   |',
    '| implement a slice, TDD        | `{{MODEL}}`  | files changed, test counts, <= 15 lines    |',
    '| run a test suite              | Haiku        | pass/fail counts, failing test names only  |',
    '| review a diff                 | `{{REVIEWER_MODEL}}`, always | the section 4 verdict, <= 20 lines |',
    '| fix review findings           | `{{MODEL}}`  | what changed, <= 10 lines                  |',
    '| write a document > 100 lines  | Sonnet       | the path plus <= 5 lines                   |',
    '',
    'Every dispatch prompt you write ends with an explicit line budget'].join('\n'));
  has(body, [
    "- **Every other sub-agent's model is your choice**, per the table in section 2:",
    '  `{{MODEL}}` for implementation, TDD, fixes and any judgment call the story',
    '  hinges on; Sonnet for documents over 100 lines; Haiku for exploration,',
    '  single-fact lookups, log grepping, and running or summarising tests. Spend',
    '  model capability where judgment is needed and not elsewhere.'].join('\n'));
});

test('F7 GLM DELEGATION_MODELS names glm -p for implementation and fixes, not the orchestrator model', () => {
  const m = flat(GLM_MODELS);
  has(m, '`glm -p` for implementation, TDD, fixes');
  assert.ok(!m.includes('{{MODEL}}'));
});

test('F10 BRIEF head comment admits the live tokens in the variant blocks', () => {
  const head = flat(BRIEF.slice(0, BRIEF.indexOf('\n-->')));
  has(head, 'except the variant blocks below, which hold live tokens');
});
