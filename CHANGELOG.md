# Changelog

Newest first. Technical detail per component: [`docs/bajzi-package-spec.md`](docs/bajzi-package-spec.md).

## 1.28.0
- Changed: night-run SKILL.md: never use `/goal` for an overnight watch (it keeps the session busy so CronCreate checks never fire); the cron check prompt carries the follow-up work
- Added: kill guard (PreToolUse on Bash and PowerShell, every session and sub-agent): denies by-name process kills (`taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name`, ...); kills by PID pass
- Fixed: status line git timeout raised to 3 s and a timed-out `git status` is no longer cached, so the next render retries git

## 1.27.0
- Added: `/bajzi:explain` (re-explain simply in the configured language; `--set-language <code>`; also in bajzi-cowork) and `/bajzi:tired [off]` (tired mode; SessionStart hook `tired.js`, `.tired` marker written by `session-signal.js`)

## 1.26.0
- Changed: fix: the fixer brief carries the slice's acceptance line (`FC slice` prints it)

## 1.25.0
- Changed: night-run: docs/BACKLOG.md is no longer read; stories come from add-on queues and approved plans

## 1.24.0
- project-setup: size L + hosting github now checks the CI rule: `--check` reports `DRIFT kit-ci .github/workflows` until a `*.yml`/`*.yaml` workflow exists; apply never writes `.github/` and prints a `TODO kit-ci` line telling the session to write a stack-fitting workflow.
- night-run: an approved plan file (Status APPROVED, an unchecked step) is the unit of work: PHASE B takes approved plans before open PRs and parked retries, `docs/BACKLOG.md` is a legacy fallback; the story note is `PLAN: <path> :: <criteria>` and the session generates slices from the plan (`docs/slice-format.md`, Plan -> slices) and ticks its checkboxes.
- Texts agree with the global-rules handoff path, English default and 40/50 context thresholds.
- project-setup: start assessment (one round, five questions) writes `size`, `hosting` (and `gate` for M/L) into the profile when missing; owner-approved size upgrade; README documents sizes, hosting and the pre-push guard limits.
- project-setup: profile keys `"size"` (XS|S|M|L) and `"hosting"` (local|github). Apply runs `git init` + `core.hooksPath .githooks` in a non-git folder, writes the per-size kit block into `.claude/CLAUDE.md`, the size's scaffold stubs and a `runtime/` ignore line, and installs `.githooks/pre-push` for hosting local. Additive: a bigger size only adds, owner files stay byte-identical. Refuses before any write on a foreign `.githooks/pre-push`, a foreign `core.hooksPath`, a nested repo or git that cannot run (not on PATH, dubious ownership); a damaged kit/instructions block (end marker lost) is never cut on a later rewrite; a CRLF `.claude/CLAUDE.md` is not kit drift. The `gate-hookspath` drift kind is now `hookspath`.
- gate: new pre-push hosting guard `bajzi/gate/pre-push.js`: refuses every push to a GitHub host (https, scp-like, ssh, ssh-config aliases via `ssh -G` run through git's own ssh command, insteadOf/pushInsteadOf rewrites) unless the committed (HEAD) `.claude/project-profile.json` says `"hosting": "github"`. Fails closed: a missing/invalid profile, an unresolvable host or an unknown transport refuses.

## 1.23.0
- skills: new interview skills `bajzi:grilling` (model-invocable; numbered question rounds, decisions written to a record file with Proof lines, `Grilled: grilling <YYYY-MM-DD> (Q1-Qn)` header), `/bajzi:grill-me` (user entry to it) and `/bajzi:respec-cards` (owner-approved spec cards; `Grilled: respec-cards <YYYY-MM-DD> (cards NN-MM)` header). grilling and grill-me are adapted from https://github.com/mattpocock/skills (MIT, (c) 2026 Matt Pocock); see `bajzi/skills/grilling/NOTICE.md`.

## 1.22.0
- hooks: new PostToolUse security-pattern reminders for Edit/Write/MultiEdit/NotebookEdit: 16 rules (shell/eval/unsafe-deserialization calls, HTML and SQL string building, AWS key ids, private-key blocks, hardcoded passwords, TLS verify off, chmod 777, `${{ github.event.* }}` in workflow `run:`) scan only the new text and add one reminder per rule per file per session. Remind-only (never blocks), no LLM call, fails open; `.md/.mdx/.txt/.rst` files skip the code rules but keep the secret rules.
- hooks: new PostToolUse read nudge: the first whole-file Read (no offset/limit) of a code file over 300 lines adds one reminder per file per session pointing at symbol lookup, `rtk read -l aggressive` or a sub-agent. Exempt: `runtime/briefs/` and non-code files. Remind-only, fails open.
- handoff: `handoff-load.sh` caps the injected handover at 8000 bytes (cut at the last full line, followed by a `[handover truncated ...: read <path> for the rest]` marker); `/bajzi:handoff` and the night BRIEF tell sessions never to write secrets into a handover.
- review: the reviewer agent carries an inline checklist (security: injection, secrets, unsafe deserialization, missing authz, SSRF, TLS, CSRF and more, with a source/sink/path requirement and a DO-NOT-flag list; silent failures; plus tests, comments and data-shape lenses). Its body limit is 140 lines (other agents stay at 60).
- review: `brief review` hands the reviewer the slice spec (`slice:` line, when `runtime/slices/<slice>.md` exists) and treats an unmet acceptance item as a major finding.
- review: optional `docs/review-policy.md` (`## Trusted inputs`, `## Accepted risks`, `## Checks`, `## Path instructions`, `## Always read`), read at the range base commit so the reviewed diff cannot change it. Accepted risks suppress only findings they name, never a blocker; a failed project check is a major finding; changing the policy inside the range is major (`policy-changed: yes`). Over the caps (10 checks, 5 always-read paths) the brief adds a `policy-warning:`.
- review: round 1 lists `debt.md` / `needs-owner.md` as `known:` so a recorded minor/nit at the same path is not re-raised (blockers and majors always are; RESOLVED entries do not count). Round 2 gets `fix diff:` (the fixer's changes only) and reads the full diff just where a round-1 location is outside it.
- ask: every owner question in autopilot (DECISIONS and report), night-run (restriction table, morning report) and day-run's three questions is `<n>. <question> -> recommended: <answer> (<why>)` in ONE round; `yes` accepts all, `yes except <n>: <answer>` overrides rows.
- night-run: new `ci-tail.sh`: on a red `pull_request` run the story reads a redacted last-80-line failure tail (ANSI stripped, token-shaped strings redacted) instead of the raw log, dispatches one fixer, and a second red run parks the story with a `CI failure tail:` section in the PR body. The night settings allow exactly that script path; the `gh run view --log` ban stays.
- night-run: story PRs carry `Door: one-way|two-way` and `Blast radius: <one line>` body lines; the morning report lists one-way PRs first and treats a missing line as `Door: unknown` (like one-way).
- night-run: the watcher writes its morning summary per night, `<NIGHT_DIR>/lessons/<RUN_DATE>/night-watch-summary.md`, instead of overwriting one file.
- radar: the context carries paths of up to 5 recent night-watch summaries (`night lessons`); the session reads them as untrusted data, reports a lesson recurring in 2+ nights and applies a retro lens (a repeatedly broken rule becomes a deterministic check, an unused rule is deleted).

## 1.21.0
- night-run: new optional `config.env` key `BRANCH_LOCK_CMD`: the absolute path of an external lock adapter that `run.sh` calls around every story (`acquire <worktree> <lock-id> <branch>`, `heartbeat <lock-id>` every >= 30 s, `release <lock-id>` on every exit path; lock-id = 8 lowercase hex chars; argv only, `timeout 30`). In lock mode `run.sh` creates the story worktree itself (after `git fetch --prune`). It releases: its own leftover lock from a killed run, before preparing the tree (a failed leftover release keeps the id and defers the story); the id of an acquire that timed out, errored or was interrupted by a signal; and, once more before it exits, an id whose release after its story failed. An existing story tree with a detached HEAD is continued in. New state tokens `DEFERRED-locked` (`holder=<text>`) and `BLOCKED-lock`. Empty (default) changes nothing; a relative, missing or non-executable path stops `run.sh` with exit 2.
- night-run: new optional `config.env` key `BRANCH_NAMESPACE` (default `feat`) sets the first segment of every story branch, `<BRANCH_NAMESPACE>/<BRANCH_PREFIX>-<id>-<slug>`, in the story prompt, the brief, the push allow rules and the supervisor's night-PR match. The default changes nothing; an invalid value stops `run.sh` and `supervise.sh` with exit 2.

## 1.20.0
- night-run: the watcher now notifies by default. With `WATCH_NOTIFY_CMD` unset, the new `notify.sh` pushes status changes and each new terminal state row (`<id> <token>`, never paths or reasons) to ntfy.sh (`ORCH_NTFY_TOPIC`, else the first non-empty line of `~/.claude/bajzi/ntfy-topic`) and, on Windows, shows a balloon toast (off with `ORCH_NOTIFY_NO_TOAST=1`). A failure is one WARNING line. Test/override server: `ORCH_NTFY_SERVER` (default `https://ntfy.sh`).

## 1.19.0
- Per-subagent effort (Claude Code 2.1.292+): `effort:` in the agent frontmatter (reviewer high, implementer medium, implementer-risk high, fixer medium). The day-run routing table names an effort per task class (final whole-branch review xhigh) and passes it as the Agent tool's `effort` parameter on Claude dispatches.
- Pacing sentence added to the locate/map, tests, long-file-read, implement and fix briefs (never review or debugging briefs).
- `/bajzi:setup` PHASE D installs a plugin with a missing marketplace in one command (`claude plugin install <id> --marketplace <source>`); `marketplace add` remains the fallback below Claude Code 2.1.292.
- Hooks: the `pre-tool.js` guard hook (hosts the secret, writer, saver and context guards; Claude Code 2.1.295+) fails closed (`onFailure: block`, timeout 10); the dispatch guard stays fail-open.

## 1.18.0
- License changed from MIT to PolyForm Noncommercial 1.0.0 (noncommercial use only).
- Public cleanup: documentation rewritten for a public reader.
- Night-run gains `ADDON_SKILLS`: optional add-on skills that supply queue sources, brief rules and permissions.
- Project-specific integrations moved out of the package.

## 1.17.0
- New skill `/bajzi:which <intent>`: names the installed skill or slash command that fits what you want to do, with the exact command and where it is installed. Read-only; reads `~/.claude/skill-catalog.json` when present.
- Day-run rules no longer mention a memory-plugin observation cap.

## 1.16.1
- Night run: after your go, the planning session launches the run itself (`launch.sh`) and reports the process group; the launch block no longer has to be pasted into a terminal. On a harness refusal it falls back to handing you the command.
- `launch.sh` strips the launching session's provider and session-identity environment before starting the runner.
- `/bajzi:setup` also installs the `humanizer` plugin (prose rewriting).

## 1.16.0
- Saver hard routing: at saver level L2/L3 the split (Claude orchestrates, GLM writes the code) is enforced by a PreToolUse saver guard instead of injected text. Edit/Write outside `runtime/`, writer agents and obvious shell writes are denied on a Claude session; Claude cannot change its own level.
- New `split` launcher (Linux): Claude main session in an OS sandbox with the level pinned to L2.
- `/bajzi:implement`, `/bajzi:fix` and `/bajzi:debt` run their brief through `glm -p` after a `saver-guard:` deny.
- Night run at L2/L3 runs on `glm` with a GLM delegation table; sprints end parked with a review-queue item.

## 1.15.2
- Night-run tests no longer leave a supervisor process behind.

## 1.15.1
- Health-gated night-run supervisor: the periodic Opus supervisor tick runs only when a zero-token shell pre-check trips (runner dead, no progress, untouched PR, escalation, deadline near). A forced tick still runs every `SUPERVISE_FORCE_EVERY_MIN` minutes; `0` turns the gate off.
- `supervise.sh --check` prints the verdict the running loop would reach.

## 1.15.0
- Night-run hardening: per-project settings template, GLM preflight at saver L1-L3, fresh `launch.sh` and base branch on every plan, a periodic supervisor session that can relaunch a dead runner.
- `/bajzi:setup` writes explicit env-file deny names to `~/.claude/settings.json` instead of `Read(.env.*)`; `--check` reports the old rule as `DRIFT leftover-deny`.
- GLM model split: top-level GLM sessions use `glm_orchestrator_model`, sub-agents and nested `glm -p` use the flash model; new `worker --set-orchestrator-model`.
- Status line shows the 5-hour and 7-day Claude plan usage.

## 1.14.1
- Per-session saver level: `worker --level` inside a session changes only that session.
- `worker --level --global` sets the machine default.

## 1.14.0
- Session status records (`<id>.event.json`, `<id>.artifacts.jsonl`, `<id>.line.json`) written for an optional external orchestrator.
- New mods `cache-timer` and `nightrun-pane` (0.1.0).

## 1.13.1
- Dispatch guard applies its second rule only to editing agents.
- One dispatch log line per dispatch.

## 1.13.0
- Night-run triage watcher may fix a blocking environment failure.
- The watcher's bash tick runs sandboxed.

## 1.12.0
- Writer guard: only a session started in the bajzi repo's main checkout changes the plugin files.
- Other sessions are denied Edit/Write and send a request instead.

## 1.11.0
- New skill `/bajzi:radar`: biweekly read-only review of the Claude setup.
- Its items are adopted or declined by you.

## 1.10.1
- The PreToolUse and PostToolUse checks (context guard, secret guard, injection scanner) run in one combined Node process per event (`pre-tool.js`, `post-tool.js`).
- Day-run rules trimmed.

## 1.10.0
- Sonnet takes the second fix round.
- Reproducible-bug debugging and non-risk work route to sonnet.

## 1.9.0
- Agents: `implementer`, `implementer-risk`, `reviewer`, `fixer`.
- Skills `implement`, `review`, `fix` and `debt`, and the findings format.
- The dispatch guard and the pre-commit gate.
