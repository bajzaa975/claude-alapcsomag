# Changelog — bajzi plugin

Newest first. Details per change: `docs/bajzi-package-spec.md` §11.

## 1.16.1
Night run: the session launches it (owner, 2026-10-06). The owner's go stays the gate; the owner no longer pastes the
launch block into a terminal.
- **PHASE E** (`nr-claude-launches`): after the PHASE D approval and the owner's go, the night-run session runs
  `bash <NIGHT_DIR>/launch.sh` and the one-runner check itself and reports the pgid. Fallback only on a harness refusal
  (auto-mode classifier, declined permission prompt): stop, quote it, hand the owner the same command. `set-zai-key.sh`
  stays owner-typed.
- **launch.sh** strips the launching session's provider and session-identity env (`ANTHROPIC_*`, `CC_ROUTER_*`, `CC_WORKER_MODE`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `BAJZI_SESSION_LEVEL`) before starting the runner; supervise.sh's tick scrub matches (test: `stale-inputs.test.js`, Linux).
- SKILL.md precedence: PHASE E is exempt from "the design spec wins"; spec, README and template comments reworded.

## 1.16.0
Saver hard routing (owner, 2026-10-06): the L2 split (Claude orchestrates, GLM writes the code) is enforced
mechanically instead of by injected text. Measured before: machine L3 + day-run on, `worker --usage` 84% Claude / 16% GLM;
a VM night at L2 100% Claude, 0 GLM requests.
- **Saver guard** (`hooks/node/saver-guard.js`, PreToolUse): at L2/L3 on a Claude session, Edit/Write outside
  `runtime/`, writer agents and obvious shell writes are denied; Claude cannot change its own level (`! worker --level`
  is the owner's). Targets are judged in every path form (text-collapsed and link-first real path; all must pass); the most specific root wins
  (project vs tmp/memory); control files are matched on the literal and the real path. Peak window: writes
  allowed and logged (`cause=peak`).
- **`split` launcher** (Linux tier): Claude main session + OS sandbox (`--settings`: denyWrite = project root; excluded
  only `glm`, `git add`, `git commit` (+rtk forms) and the exact findings CLI), pinned L2 via `CC_WORKER_MODE=glm`,
  bwrap namespace probe; the Edit tools write only `runtime/` and memory (no tmp: the sandboxed shell writes it, so a
  link swap could race the check). Verified live on the VM: every shell write, fetch/switch-from-tmp, `--upload-pack`, gh alias,
  global git config and symlink writes blocked; `glm -p` writes and `git add`/`commit` work. Windows: guard tier.
- **Split scratch** (`saver-split-scratch`): a split session's refused Edit/Write of a pure tmp file (every path form
  shell-writable, none in the project) is logged `cause=scratch`, not `cause=blocked`, so code-write denies = `cause=blocked`
  lines only; the SessionStart saver block tells a sandboxed split session to write scratch files with the Bash tool.
- **Skills**: `/bajzi:implement`, `/bajzi:fix`, `/bajzi:debt` run the brief through `glm -p --permission-mode
  bypassPermissions` on a `saver-guard:` deny (acceptEdits measured unable to run tests).
- **Night run at L2/L3**: config.env `CLAUDE_BIN="glm"`, GLM delegation table in BRIEF, PHASE D gates (glm -p, CLAUDE_BIN,
  no peak overlap), `gh pr merge` denied, sprints end parked with a review-queue item; L0/L1 restores the owner's values.
- Messages: SessionStart and `worker --level` say a level does not switch a running session's provider.

## 1.15.2
Night-run test fix (pre-existing since 1.15.0): `quota.sh` and `lock-race.sh` left a `supervise.sh` running and failed
their "no processes left behind" check on Linux.
- **Fix** (`test-supervisor-leak`): the shared fixture `tests/lib.sh` `nr_config` writes `SUPERVISE="0"`; a caller can
  still pass `SUPERVISE="1"`. Implemented and fixed by a nested `glm -p` worker, reviewed by Opus (r2 CLEAN).
- Spec §11: 1.15.1 marked released and installed.

## 1.15.1
Health-gated night-run supervisor (owner, 2026-10-05): the 30-minute Opus supervisor keeps all its powers, but each tick
now runs only when a zero-token shell pre-check trips.
- **Gate** (`supervise-gate`): `supervise.sh` `gate_check` before every tick — runner dead or unknown, no progress for
  `SUPERVISE_STALL_MIN` (45), a night PR green or red and untouched, a new triage `ESCALATE`, the deadline within
  `SUPERVISE_DEADLINE_MIN` (60) with stories left, `watch.status` not OK. All healthy -> `OK healthy`, no Opus.
- **Forced tick** every `SUPERVISE_FORCE_EVERY_MIN` (120); `0` turns the gate off (every tick Opus, the 1.15.0 behaviour).
- `supervise.sh --check` prints the verdict the running loop would reach; `run.sh` validates the three new keys.
- Spec: night-run deny count 67 -> 58 (claude-orchestrator dropped its inert `Write(...)` denies).

## 1.15.0
Night-run hardening (owner's innotel-bss prompt, 2026-10-03) and the status-line plan limits.
- **Night-run settings** (`nr-settings`, `nr-settings-f9`): per-project `settings.local.json` template with explicit env-file
  names, worktree mirrors, the `docker:` rule and neighbour-container denies.
- **GLM preflight** (`nr-glm-preflight`): at saver L1-L3 PHASE A checks `glm`/`worker` on PATH, the Z.ai key and a GLM smoke run.
- **Stale inputs** (`nr-stale-inputs`, `-f6`): `launch.sh` rendered on every plan from the running plugin copy; BASE refreshed
  onto a fresh `night/base-*` branch before rendering; re-render on merges; REQUIRED_CHECK meaning documented and checked.
- **Supervisor** (`nr-supervisor`): a fresh Opus session every 30 minutes (`SUPERVISE=0` turns it off) that can relaunch a dead
  runner and merge finished PRs; runs from BASE with the night deny list minus only the state-file deny
  (`supervise.settings.json`), relaunches with the runner-only line (never `launch.sh`), stops past the deadline or when the
  runner is dead for good, dated `SUPERVISE-STOP`.
- **User-level env denies**: `/bajzi:setup` writes explicit env-file deny names to `~/.claude/settings.json` instead of
  `Read(.env.*)` (which also blocked the tracked `.env.example`); `--check` reports the old rule as `DRIFT leftover-deny`, and
  night-run PHASE A step 7 blocks planning while such a rule remains. Setup never deletes it: remove `Read(.env.*)` /
  `Edit(.env.*)` from `permissions.deny` by hand.
- **Planning rules** (`nr-planning-rules`): restrictions asked once, no silent deferral, multi-day deadlines with `--date`
  pinned on every relaunch.
- **GLM model split** (`glm-flash`): top-level GLM sessions on `glm_orchestrator_model` (glm-5.3), sub-agents and nested
  `glm -p` on glm-5.3-flash; `worker --set-orchestrator-model`; `--set-*` writes only its own key.
- **Status line**: shows `5h N%` and `7d N%` Claude plan usage; the session line record gains `seven_day_pct`.

## 1.14.1
- Per-session saver level: `worker --level` inside a session changes only that session (`--global` for the machine default).
