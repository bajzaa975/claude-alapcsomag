# Changelog

Newest first. Technical detail per component: [`docs/bajzi-package-spec.md`](docs/bajzi-package-spec.md).

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
