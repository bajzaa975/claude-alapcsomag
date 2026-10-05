# Changelog — bajzi plugin

Newest first. Details per change: `docs/bajzi-package-spec.md` §11.

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
