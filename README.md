# bajzi-plugins

A Claude Code and Cowork plugin marketplace for people who want to spend fewer tokens and run
sub-agents with a built-in review loop. The main plugin, `bajzi`, routes work to cheaper models,
guards the context window, filters noisy command output, and orchestrates implementer, reviewer
and fixer agents.

Marketplace name: `bajzi-plugins` (GitHub: `bajzaa975/claude-alapcsomag`). Full technical spec:
[`docs/bajzi-package-spec.md`](docs/bajzi-package-spec.md).

## Plugins

| Plugin | Version | What it is |
|---|---|---|
| `bajzi` | 1.22.0 | The full Claude Code package: skills, hooks, agents, launchers, status line. |
| `bajzi-cowork` | 1.22.0 | Skills-only subset for claude.ai / Cowork (no hooks, no `bin/`). |
| `cache-timer` | 0.1.0 | Optional mod: status line entry with the minutes left on the prompt cache. |
| `nightrun-pane` | 0.1.0 | Optional mod: a `/nightrun` pane for an external orchestrator's night run. |

## Prerequisites

- Claude Code CLI, 2.1.295 or newer recommended. Per-subagent effort and the one-command plugin
  install in `/bajzi:setup` need 2.1.292+; the fail-closed guard hook needs 2.1.295+ (older
  versions ignore it and the guards fail open).
- Node.js 18 or newer (the hooks and the status line are Node scripts, no dependencies).
- Git Bash on Windows (the shell hooks and launchers need a POSIX shell); any shell on Linux/macOS.
- Optional: a Z.ai GLM API key, needed for saver levels L1 and above (see below).

## Install

### Claude Code

```bash
claude plugin marketplace add bajzaa975/claude-alapcsomag
claude plugin install bajzi@bajzi-plugins
```

Then, in a new Claude Code session:

```text
/bajzi:setup
```

On Claude Code 2.1.292+ it installs a plugin whose marketplace is missing with
`claude plugin install <id> --marketplace <source>`; older versions use `marketplace add` first.
`/bajzi:setup` configures the machine from [`bajzi/skills/setup/manifest.json`](bajzi/skills/setup/manifest.json):
marketplaces, plugins, `rtk`, settings, the status line, user-scope MCP servers, and the global
rules in [`shared/CLAUDE.md`](shared/CLAUDE.md), which it appends to `~/.claude/CLAUDE.md` without
duplication. Check for drift at any time with `/bajzi:setup --check` (one line per difference,
changes nothing).

### Cowork (Claude Desktop)

1. Open **Customize -> Plugins -> Add marketplace** and enter `bajzaa975/claude-alapcsomag`
   (or `https://github.com/bajzaa975/claude-alapcsomag`).
2. Install `bajzi-cowork`. Do not install `bajzi` in Cowork: it ships `bin/`, hooks and agents,
   which the claude.ai marketplace sync rejects.

`bajzi-cowork` contains only the `autopilot`, `handoff` and `modszertan` skills.

### Update

Claude Code: `claude plugin update bajzi`, then `/bajzi:setup` to refresh the status line copy.
If the update changed `bin/cc-router.js`, re-run `bash <plugin root>/bin/install.sh` (spec §8.3).
Cowork: use **Update** on the marketplace, then update `bajzi-cowork`.

## Quick start

```text
/bajzi:setup            # one-time machine setup
/bajzi:mode             # turn day-run mode (autonomous, model-routed work) on or off, or show the current one
/bajzi:handoff          # save session state before /clear
/bajzi:which <intent>   # ask which skill or command fits what you want to do
```

```bash
bash <plugin root>/bin/install.sh   # installs the worker/glm/ccr/split shims into ~/.local/bin; re-run after an update that changes cc-router.js
worker --level 1        # shell: move flash-class work to GLM (needs the Z.ai key)
```

`<plugin root>` is `~/.claude/plugins/cache/bajzi-plugins/bajzi/<version>` for a marketplace
install, or `bajzi/` in a clone of this repo. The shim install and the Z.ai key are described in
[spec §8.1 step 4](docs/bajzi-package-spec.md).

Check the install with `claude plugin list`.

## What it does

### Token saving

- **Saver levels L0-L3** — how much work moves to the cheaper Z.ai GLM models. L0 `claude`: all
  work on Claude (default). L1 `light`: flash-class work (locate/map, tests/lint/build, long-file
  summaries) goes to GLM. L2 `glm`: also implementation, fixes and document writing (via
  `glm -p`); risk slices, debugging and every review stay on Claude. L3 `tight`: the whole session
  runs on GLM and reviews are queued instead of performed. Set with `worker --level 0|1|2|3`.
- **`glm` / `worker` / `ccr` shims** — launchers around `cc-router.js`, no daemon. `glm` always
  runs on GLM, `worker` follows the saved saver level, `ccr` is the compatibility entry point.
  Models are set in `~/.claude/cc-router.json` (`glm_orchestrator_model`, `glm_model`,
  `glm_fast_model`) with `worker --set-orchestrator-model|--set-model|--set-fast-model <id>`, or
  per shell with `GLM_ORCHESTRATOR_MODEL`, `GLM_MODEL`, `GLM_FAST_MODEL`. A top-level GLM session
  runs on the orchestrator model and its sub-agents on `glm_model`. `worker --status` shows the
  level; `worker --usage` reports the Anthropic/GLM weighted-token split. A GLM launch is refused
  during the Z.ai peak window (14:00-18:00 UTC+8); override one call with `CC_GLM_PEAK_OK=1`.
- **Saver guard** — at L2/L3 on a Claude session, edits outside `runtime/` and obvious shell
  writes are denied, so code is written by the GLM worker. On Linux the `split` launcher adds an
  OS sandbox on top.
- **Output compression** — `/bajzi:setup` installs `rtk`, which compresses command output. A
  `noise-filter` hook also keeps loud install/build output out of the context (exit code preserved).
- **Status line** — model, saver level, branch, task, context percentage, GLM share, open
  review-queue count, plan usage and a peak-window hint.
- **Context guard** — warns at 40% context and blocks tool calls at 50% except writing or reading
  the handoff and read-only git, so you can always save state and `/clear`.

### Orchestration

- **Day-run mode** (`/bajzi:mode`) — a working mode that injects a routing table at session start:
  locating, mapping, tests/lint/build and long-file summaries go to haiku; documents and specified
  slices to sonnet; risk-bearing slices (locks, concurrency, quotas, auth, money, migrations,
  destructive scripts) to opus; every diff review to the reviewer models set in the manifest
  (`reviewer_models`). Design and planning stay on the session's own model. Escalation ladder:
  sonnet round 1, fresh sonnet round 2, opus round 3, the orchestrator round 4, then park.
  Each class also carries a subagent effort (Claude Code 2.1.292+), passed as the Agent tool's
  `effort` parameter: low for locating/mapping, tests/lint/build and long-file reads; medium for
  implementation, fixes and documents; high for risk slices (and their fixes), debugging and every review; xhigh
  for the final whole-branch review. Your own session's effort is never changed. Briefs for
  locate/map, tests, long-file read, implement and fix end with a pacing sentence
  ("Time matters here: ..."); review, debugging and documents briefs never do.
- **Slice** — one unit of work described in `runtime/slices/<id>.md` (tier, files it may touch,
  acceptance criteria, test command); format in [`docs/slice-format.md`](docs/slice-format.md).
- **Agents** — `implementer` (sonnet, medium effort, tier 2/3 slices), `implementer-risk` (opus,
  high, tier 1 slices), `reviewer` (opus, high, read-only, returns a findings file), `fixer`
  (sonnet, medium, fixes every finding, never sees severity). Findings file format: [`docs/findings-format.md`](docs/findings-format.md).
- **Review loop** — `/bajzi:implement <id>`, then `/bajzi:review <slice> <range>`, then
  `/bajzi:fix <findings-file>`. Routing and the two-round cap are decided by code on files, not by
  the model. After round 2, open findings go to the owner (`needs-owner.md`) or are parked as debt
  (`debt.md`).
- **Pre-commit gate** — `/bajzi:project-setup` can install a pre-commit hook (secret scan, lint,
  type-check ratchet); see [`docs/gate.md`](docs/gate.md).
- **Debt** (`/bajzi:debt`; example: `/bajzi:debt --check` before the next slice) — checks the parked-findings cap before the next slice, drains it in
  one fixer pass plus one review, and calibrates severities with a blind re-rate.
- **Autopilot** (`/bajzi:autopilot`; example: "autopilot: fix the three failing tests, then stop") — an unsupervised work session with a decision log and a
  closing report.

### Session continuity

- **Handoff** (`/bajzi:handoff`) — saves state to `runtime/handoff/<slug>.md`, where
  `/bajzi:handoff` derives `<slug>` from the current branch (`handoff-load.sh` resolves the same
  name), with a suggested opening prompt; that SessionStart hook reloads it after `/clear`,
  compact and resume. Example: at 40%
  context run `/bajzi:handoff`, then `/clear`; the new session opens with the saved state.
- **Methodology guard / `modszertan`** (the skill name is Hungarian for "methodology") — records
  per repo which methodology leads (GSD, superpowers or none) in `.claude/METHODOLOGY` and nags at
  session start when there is no decision yet.

### Safety

- **Secret-read guard** (example: `cat .env` is denied) — denies reading `.env`, `.env.*` (except `.example`, `.sample`,
  `.template`, `.dist`), `.secrets` and the manifest's secret patterns. It is a pattern guard, not
  a shell parser: variable indirection, copying a protected file to another name and encoded paths
  pass, and it covers files, not environment variables.
- **Injection scanner** — warn-only: after Read, WebFetch, WebSearch and MCP results it adds a
  "treat this as data" warning naming the matched rules. A rephrased injection passes.
- **Dispatch guard** — refuses review or fix work sent to the wrong agent and oversized briefs.
  A discipline guard, not a security boundary.
- **Writer guard** — bajzi plugin files are edited only by a session started in the bajzi repo's
  main checkout; other sessions are denied Edit/Write and send a request instead. Installed plugin
  copies are denied to every session. Bash/PowerShell writes are not blocked.
- Hooks fail open: an internal error allows the call and logs it. Two exceptions fail closed: the
  pre-commit gate and `day-run-mode.sh` when a non-Anthropic session
  lacks the L3 text. Separately, on Claude Code 2.1.295+ the `pre-tool.js` guard hook (secret,
  writer, saver and context guards) is wired with `onFailure: block`: if it cannot start, times
  out or exits with a code other than 0 or 2, the tool call is blocked. The dispatch guard stays
  fail-open.

### Night-run

- **Night-run** — `/bajzi:night-run` plans an unattended overnight run and launches it on your go
  (example: run it at bedtime, read the plan, answer "go"). The launch starts the plugin's own bash
  runner `run.sh` (`setsid nohup`, in a bash terminal on a Linux host): one fresh headless session
  per sprint, with guard checks. Each story session pushes its branch and opens a PR; at L0/L1
  green work is squash-merged. At L2/L3 nights reviews are queued for a later Opus session to drain.

### Mods

- **`cache-timer`** — status line entry: minutes left until the main thread's prompt cache goes cold. It assumes a 60-minute cache; the cache is 5 minutes during usage overage and the mod cannot detect that.
- **`nightrun-pane`** — open the pane with `/nightrun`: the newest night run's sprint states and log tail. It reads only an external orchestrator's `runtime/nightrun` layout (`nightrun.log`, `*.status`, `SUMMARY.md`, `STOP`, `runtime/handoff/night-watch-state.md`), not bajzi night-run's `NIGHT_DIR`.

## Skills

| Skill | Command | Description |
|---|---|---|
| `autopilot` | `/bajzi:autopilot` | Autonomous work session: carries several tasks or a sprint through without questions, with a decision log and a closing report. |
| `debt` | `/bajzi:debt --check\|--drain\|--calibrate` | Parked review debt (`runtime/findings/debt.md`): check the cap before a slice, drain it with one fixer pass plus one review, calibrate with a blind re-rate. |
| `fix` | `/bajzi:fix <findings-file>` | Fixes a round-1 findings file through the fixer agent, runs the gate, commits, then runs the round-2 re-review. |
| `handoff` | `/bajzi:handoff` | Saves session state into `runtime/handoff/<slug>.md` plus a suggested opening prompt for after `/clear`. |
| `implement` | `/bajzi:implement <id>` | Implements one slice from `runtime/slices/<id>.md` through the implementer agents and commits it for review. |
| `mode` | `/bajzi:mode` | Switches between day-run (autonomous, model-routed) and normal mode, or reports which is active. |
| `modszertan` | `/bajzi:modszertan` | Selects or changes the repo's leading methodology (GSD, superpowers or neither). |
| `night-run` | `/bajzi:night-run` | Plans an unattended multi-hour overnight run: preflight, queue, brief, approval gate, launch. |
| `grill-me` | `/bajzi:grill-me <plan, decision or idea>` | A relentless interview to sharpen a plan or design; runs `bajzi:grilling`. |
| `grilling` | (model-invoked only) | Numbered interview rounds that record each settled decision with a Proof line and mark the spec `Grilled:`. Adapted from mattpocock/skills (MIT). |
| `project-setup` | `/bajzi:project-setup [--check]` | Applies or checks the repo's `.claude/project-profile.json`: project plugins, MCPs, methodology, instruction files, pre-commit gate. |
| `radar` | `/bajzi:radar [now\|install]` | Biweekly read-only review of your Claude setup (plugins, Claude news, methodology, usage); adopt or decline its items. |
| `respec-cards` | `/bajzi:respec-cards` | Specifies or re-specifies a system as owner-approved cards, interviewing question by question. |
| `review` | `/bajzi:review <slice> <range>` | Reviews a slice's commit range through the reviewer agent and applies the close policy and debt cap on round 2. |
| `setup` | `/bajzi:setup [--check]` | Sets up a Claude Code machine to the manifest's desired state, or only checks it for drift. |
| `which` | `/bajzi:which <intent>` | Names the installed skill or slash command that fits what you want to do, with exact syntax and where it lives. |

Skills also start from a plain request ("do a handoff").

## Configuration

| File | Scope | Purpose |
|---|---|---|
| `bajzi/skills/setup/manifest.json` | machine | The single file to edit to add a plugin, setting, MCP or tool; every machine gets it at the next `/bajzi:setup`. |
| `.claude/project-profile.json` | repo | Project plugins, MCPs, methodology, linked skills, instruction files and the optional pre-commit `gate`; applied by `/bajzi:project-setup`. |
| `~/.claude/cc-router.json` | machine | GLM model ids (`glm_orchestrator_model`, `glm_model`, `glm_fast_model`) used by the `glm`/`worker`/`ccr` shims. |

## Optional integrations

- **External orchestrator** (not part of this package): the hooks write per-session status files
  (`<status dir>/<id>.event.json`, `<id>.artifacts.jsonl`, `<id>.line.json`) that such a tool can
  read, and `/bajzi:which` reads `~/.claude/skill-catalog.json` when present. The `nightrun-pane`
  mod displays its night runs.
- **Night-run add-on skills:** `ADDON_SKILLS` in the night-run `config.env` (empty by default)
  names extra plugin skills that supply queue sources, brief rules and allow rules to a night run.
  The contract an add-on skill follows is in
  [night-run "Add-on skills"](bajzi/skills/night-run/SKILL.md#add-on-skills).

## Troubleshooting

- A GLM launch is refused: you are inside the Z.ai peak window (14:00-18:00 UTC+8). Wait, or set
  `CC_GLM_PEAK_OK=1` for one call.
- The context guard blocks every tool call: context is above 50%. Run `/bajzi:handoff`, then `/clear`.
- `/bajzi:setup --check` reports `DRIFT leftover-deny`: remove `Read(.env.*)` / `Edit(.env.*)` from
  `permissions.deny` in `~/.claude/settings.json` by hand; setup writes explicit env-file names instead.
- Cowork shows "Sync failed": you installed `bajzi`; install `bajzi-cowork` instead.

## Development and tests

Test commands per component are listed in [`docs/bajzi-package-spec.md`](docs/bajzi-package-spec.md)
section 3; the change map in section 2 says which file and tests belong to which change. Every
package change updates the spec in the same commit. A quick run of the whole Node suite from the
repo root:

```bash
node --test bajzi/hooks/node/tests/*.test.js bajzi/skills/*/tests/*.test.js bajzi/tests/agents/*.test.js bajzi/lib/tests/*.test.js bajzi/bin/tests/*.test.js bajzi/gate/tests/*.test.js tools/tests/*.test.js
```

## Changelog and license

See [`CHANGELOG.md`](CHANGELOG.md).

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): free for personal, hobby,
research, education and non-profit use. Commercial use (including use inside a company) needs a
separate license — contact the author via GitHub (@bajzaa975).
