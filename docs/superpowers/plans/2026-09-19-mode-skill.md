# Plan — bajzi:mode ("day-run" default working mode)

Branch: feat/mode-skill (off origin/main 3bdbdf2). Plugin version stays 1.5.14 — the owner bumps.
Spec: Day Run Model Routing artifact, revision 2 (https://claude.ai/artifact/QE7upUmGKCfnjCSqRi7TGV). All new text is English only.

## Decisions taken up front

1. **Missing mode file = no injection.** The hook injects only when the resolved mode file exists
   and its first word is `day-run`. A bare plugin install must not reroute a stranger's session,
   and hook output is paid on every session at the orchestrator's price. `bajzi:setup` and
   `bajzi:alapcsomag` create `~/.claude/bajzi-mode` with `day-run`, so the owner's machines are
   day-run-by-default exactly as the spec requires. `/bajzi:mode status` with no file reports
   "not set — the plugin behaves as normal; run /bajzi:mode day-run to enable".
2. **A new, dedicated SessionStart hook**, `bajzi/hooks/day-run-mode.sh`, modelled line-for-line on
   `methodology-guard.sh`. Not folded into `handoff-load.sh`: that script has four mutually
   exclusive exit paths and the block must print on all of them, including the no-handoff
   `printf '{}'` path — folding it in means rewriting every exit of the plugin's most
   safety-critical hook. `hooks.json` already wires two SessionStart hooks; a third is the pattern.

## Files, owners, acceptance criteria

Owners A/B/C/D/F/G touch disjoint files and can run fully in parallel. E depends on A, B, D.

### A — `bajzi/skills/mode/SKILL.md` (new)
Frontmatter in the handoff/autopilot style: `name: mode`, one `description:` line naming the
triggers ("mode", "day-run", "normal mode", "which mode am I in").
Body:
- Argument grammar: `day-run | normal | status`, optional `--project`. No argument = `status`.
  Anything else: print the grammar in one line and stop.
- Target file: `--project` -> `<repo>/runtime/bajzi-mode`, otherwise `$HOME/.claude/bajzi-mode`.
  Resolution order on read: `runtime/bajzi-mode` wins over `~/.claude/bajzi-mode`.
- Atomic write, exactly: `mkdir -p <dir>; t="<dir>/.bajzi-mode.$$"; printf '%s\n' <mode> > "$t" &&
  mv -f "$t" "<dir>/bajzi-mode"` — temp file in the same directory so `mv` is a rename.
- Read with `head -1 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'` (mirror the hook exactly).
- On a switch to `day-run`, apply it to the running session: read
  `${CLAUDE_PLUGIN_ROOT}/skills/mode/DAY-RUN-RULES.md` and restate it as the active rules. On a
  switch to `normal`, state that the day-run rules no longer apply in this session.
- `status` prints three short lines: effective mode, which file it came from, and whether a project
  override is in force. No file dumps.
- Standing constraints, stated in the skill text: only `/usr/bin/git`, **one git command per Bash
  call**; `kill` is banned; the skill never merges, never pushes, never runs `claude`; it never
  reads a file over 300 lines; English only.
- Points at the four dispatch templates and at `runtime/DAY-RUN.log`.
Acceptance:
- `head -4 bajzi/skills/mode/SKILL.md` shows valid frontmatter with `name: mode`.
- `grep -c '' bajzi/skills/mode/SKILL.md` <= 120.
- `grep -nE '\bkill\b|git merge|git push|(^|[^-])\bclaude \b' bajzi/skills/mode/SKILL.md` returns
  only lines that forbid them.
- `grep -n 'mv -f' bajzi/skills/mode/SKILL.md` shows the atomic write.
- `LC_ALL=C grep -nP '[^\x00-\x7F]' bajzi/skills/mode/SKILL.md` is empty (English only, ASCII).

### B — `bajzi/skills/mode/DAY-RUN-RULES.md` (new)
The exact text the hook prints. **Hard cap 40 lines.** Encodes spec sections 2-7, compactly:
- Header line: `DAY-RUN MODE — /bajzi:mode normal turns this off.`
- ORCH substitution note: "ORCH = the model this session started with. Sub-agent tiers are fixed."
- Orchestrator-only work (s2): ask/brainstorm, design & architecture, decomposition into slices
  with disjoint file ownership and written acceptance criteria, verdict judging, the consistency
  pass after parallel fixers, and edits that meet the direct-edit threshold.
- Routing table (s3), one line per class: locate/map -> haiku (paths and line numbers only, retry
  once with sonnet, never in the main thread); tests/lint/build -> haiku (counts + first failing
  assertion); file > 300 lines -> haiku summary; documents > 100 lines -> sonnet; specified slice /
  TDD -> sonnet; risk-bearing slice (locks, concurrency, quotas, auth, money, migrations,
  destructive scripts, or 3+ files) -> opus from round 1; fix findings -> the implementer's model,
  never the reviewer; review a diff -> opus always, fresh context, EVIDENCE line or it is a FAIL;
  final review of risk-bearing logic -> ORCH only when ORCH is Fable; debugging -> opus, then ORCH
  after the third failed round; design/planning -> ORCH, main thread.
- Ladder (s4): sonnet r1 -> opus r2 -> ORCH r3 -> park. Climbs on the FIRST failure. An identical
  blocking finding twice with no diff change parks immediately.
- Direct-edit threshold (s5), all four required: <= 20 changed lines, one file; no new logic; the
  file is already in context; not a forbidden zone (deploy, secrets, CI config, migrations,
  history rewrite).
- Context discipline (s6): sub-agent reports <= 40 lines, paths and counts, never file contents,
  raw test output or diffs; the main thread never opens a file over 300 lines; 40% ceiling ->
  finish the slice, write the handoff, ask to clear; parallel fixers own disjoint files followed by
  a consistency pass; one task per session.
- Fable depletion (s7): on the session-limit message start nothing new, write the handoff, say
  "Fable limit reached. Restart with Opus." -> `claude --model claude-opus-5`; the same rules
  reload, ORCH is Opus, no rung spends Fable.
- Every dispatch's first line is `model: <name> — <reason>`.
- Log line, literally: `<ISO time> <task-class> model=<name> rounds=<n> result=<pass|fail|park|direct>`
  appended to `runtime/DAY-RUN.log`, one line per dispatch.
- Three allowed questions: scope change, forbidden zone, park-or-continue. Everything else is
  decided and logged. Day-run never merges.
Acceptance:
- `grep -c '' bajzi/skills/mode/DAY-RUN-RULES.md` <= 40.
- `grep -q 'result=<pass|fail|park|direct>'` succeeds (exact log format present).
- `grep -qi 'ORCH'` succeeds; `grep -q 'never merges'` succeeds.
- No fenced code block longer than 3 lines; no path that the reader is told to `cat`.

### C — `bajzi/skills/mode/templates/dispatch-{explore,implement,review,fix}.md` (4 new files)
Wording lifted from `night-run/templates/BRIEF.md.tmpl` (delegation table in s2; roles, loop and
verdict block in s4.1-4.2; model policy in s7), with `{{MODEL}}` resolved per the routing table.
Every template: first line `model: <name> — <reason>`; an explicit line budget; and verbatim
`Never paste file contents, raw test output or diffs into your report.`
- `dispatch-explore.md` — `model: haiku`. Returns paths plus <= 10 lines, no file bodies.
- `dispatch-implement.md` — `model: sonnet` by default, `model: opus` for a risk-bearing slice
  (list the classes). Brief must carry: owned files, acceptance criteria, test command. Returns
  files changed and test counts, <= 15 lines.
- `dispatch-review.md` — `model: opus`, always, fresh agent every round, reads the diff itself via
  `/usr/bin/git diff <base>...HEAD` and the acceptance criteria itself. Returns only the verdict
  block, <= 20 lines: `VERDICT <pass|fail>  ROUND <n>` / `BLOCKING <n>` / `NON-BLOCKING <n>` /
  `EVIDENCE:`. A pass with no EVIDENCE line is a FAIL and the round is re-run with a new reviewer.
- `dispatch-fix.md` — the implementer's model, one rung up after a failed round; never the
  reviewer. Forbidden routes to green (deleting or skipping a failing test, weakening the check).
  Returns what changed, <= 10 lines.
Acceptance: for each file, `head -1` matches `^model: `; `grep -q 'Never paste file contents'`;
`grep -c ''` <= 30; `grep -n '{{' templates/*.md` is empty (no unresolved placeholders).

### D — `bajzi/hooks/day-run-mode.sh` (new) + `bajzi/hooks/hooks.json` (modify)
Script, modelled on `methodology-guard.sh`: `set -uo pipefail`; read stdin; extract `cwd` with the
same `sed -n 's/.*"cwd"...'` one-liner, falling back to `${CLAUDE_PROJECT_DIR:-$PWD}`; the same
`json_escape` and `emit`. Plugin root:
`root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"` — env first so the
tests can point at a fake root. Resolution: `$cwd/runtime/bajzi-mode` if present, else
`${HOME}/.claude/bajzi-mode`; read `head -1 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'`.
Anything other than `day-run` (including a missing file, an unreadable file or an empty first line)
-> `printf '{}'; exit 0`, silently. On `day-run`: `head -40 "$root/skills/mode/DAY-RUN-RULES.md"`
into `additionalContext` (the `head -40` is a defensive cap independent of B), plus a one-line
`systemMessage`: `day-run mode active (<source file>). /bajzi:mode normal to turn it off.` If
DAY-RUN-RULES.md is missing or empty, emit `{}`. Dependency-free: bash, sed, awk, tr, head. It must
never fail and never read anything else.
hooks.json: add a third SessionStart entry, matcher `startup|clear|compact|resume` (compact too —
after a compaction the block is gone and must be re-injected), `timeout: 5`, command
`bash "${CLAUDE_PLUGIN_ROOT}/hooks/day-run-mode.sh"`. Update the top-level `description` string.
Acceptance:
- `bash -n bajzi/hooks/day-run-mode.sh` and `shellcheck` clean.
- `python3 -m json.tool bajzi/hooks/hooks.json >/dev/null` succeeds; the new entry is present.
- `printf '{}' | HOME=<empty> bash bajzi/hooks/day-run-mode.sh` prints exactly `{}`.
- `grep -nE '\bkill\b|\bcurl\b|\bgit\b|(^|[^./])claude([^/-]|$)' bajzi/hooks/day-run-mode.sh` is empty (the literal path .claude/bajzi-mode is allowed; a claude CLI invocation is not).
- The script contains exactly one `head -40` and no other file read besides the two mode files.

### E — `bajzi/skills/mode/tests/mode.sh` (new) + `tests/README.md` — depends on A, B, D
Bash, `set -uo pipefail`, pass/fail counters, exit non-zero on any failure. Fixture: a temp
`HOME`, a temp `cwd`, and a fake plugin root whose `skills/mode/DAY-RUN-RULES.md` is a symlink to
the real one; `PATH` prefixed with a shim dir containing a `claude` that exits 99, so any
invocation fails the run loudly. Cases:
1. `day-run` switch writes `$HOME/.claude/bajzi-mode` containing exactly `day-run\n`.
2. `normal` switch overwrites it; no stray `.bajzi-mode.*` temp file is left behind.
3. `status` reports the file's content and its source path.
4. Project override: `runtime/bajzi-mode=normal` + `~/.claude/bajzi-mode=day-run` -> hook emits `{}`.
   Reverse (`runtime=day-run`, user `normal`) -> hook emits the block.
5. Hook emits the block only for `day-run`; `normal`, an absent file, an empty file and a garbage
   word all emit exactly `{}`.
6. Whitespace/uppercase tolerance: `"  DAY-RUN \n"` is treated as `day-run`.
7. Output length: the emitted `additionalContext` is <= 45 lines
   (`grep -o '\\\\n' | wc -l`), and `grep -c '' DAY-RUN-RULES.md` <= 40.
8. No `claude` process was started (the shim's marker file does not exist).
9. A missing DAY-RUN-RULES.md emits `{}` rather than failing.
Acceptance: `bash bajzi/skills/mode/tests/mode.sh` exits 0 and prints a final `PASS n/n`; running it
twice in a row is clean; it creates nothing outside its temp dir (`git status --porcelain` empty
afterwards).

### F — `bajzi/skills/mode/README.md` (new) + both manifests (description only)
README: <= 30 lines — what the mode is, the three arguments, where the file lives, the override,
how to turn injection off (delete the file or write `normal`), and a pointer to DAY-RUN-RULES.md.
`bajzi/.claude-plugin/plugin.json`: add `/bajzi:mode day-run working mode` to `description`, add
`day-run` to `keywords`. `.claude-plugin/marketplace.json`: mention the mode skill and the third
SessionStart hook in the plugin `description`. **No `version` field changes in either file.**
Acceptance: `git diff -U0 -- .claude-plugin bajzi/.claude-plugin | grep -c '^[+-].*"version"'` is 0 (zero context lines, only real changes count); both files
parse as JSON; the two descriptions mention the skill.

### G — `bajzi/skills/setup/SKILL.md` + `bajzi/skills/alapcsomag/SKILL.md`
Add one step each: create `~/.claude/bajzi-mode` with `day-run` if it does not exist (never
overwrite an existing choice), and mention `/bajzi:mode` in the verification section. This is what
makes decision 1 safe — the owner's machines opt in, everyone else's stay silent.
Acceptance: `grep -n 'bajzi-mode' bajzi/skills/setup/SKILL.md bajzi/skills/alapcsomag/SKILL.md`
shows the create-if-absent step in both; neither uses `>` onto an existing file unconditionally.

## Pitfalls to encode in every file

- Hook output is paid at the orchestrator's price on **every** session. 40 lines is the cap, the
  hook enforces it with `head -40`, and the hook dumps no other file. No exceptions.
- The skill itself must not read large files: it reads two one-line mode files and, only on a
  switch to day-run, the <=40-line rules file.
- Only `/usr/bin/git`, **one git command per Bash call**, in every instruction the skill emits.
- `kill` is banned everywhere in this feature.
- The skill never merges, never pushes, never runs `claude`.
- English only, ASCII only, in all new files.
- The mode-file read must be byte-identical between SKILL.md and day-run-mode.sh — if they drift,
  the skill and the hook disagree about the current mode. Say so in a comment in both.

## Ordering

1. **Parallel round 1:** A, B, C, D, F, G — disjoint files, no shared state.
2. **Then E** (needs A's documented write sequence, B's text and D's script).
3. **Consistency pass** by the orchestrator across the seams: the mode-file read is identical in A
   and D; the model names in C match the routing table in B; the log format string in B matches the
   one quoted in A; the manifest descriptions in F match what A and D actually ship; G's bootstrap
   path matches D's resolution order.
4. **Fresh Opus review** of the whole diff against these acceptance criteria — reviewer reads the
   diff and the criteria itself and returns the verdict block with an EVIDENCE line, per
   dispatch-review.md. Fix round if BLOCKING > 0, then re-review with a new reviewer.
5. Owner bumps the version and merges. Day-run never merges.
