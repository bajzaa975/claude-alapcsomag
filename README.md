# bajzi-plugins — token-saving orchestration for Claude Code and Cowork

`bajzi-plugins` is a Claude Code / Cowork plugin marketplace (GitHub: `bajzaa975/claude-alapcsomag`,
marketplace name `bajzi-plugins`). It does two things: it **saves tokens** (model routing to cheaper
models, context guards, output filtering) and it **orchestrates sub-agents with a review loop**
(implementer, reviewer, fixer, with a two-round cap). The `bajzi` plugin is the full Claude Code
package; `bajzi-cowork` is a skills-only subset for claude.ai / Cowork.

Full technical spec: [`docs/bajzi-package-spec.md`](docs/bajzi-package-spec.md).

## Features

### Token saving

- **Saver levels L0-L3** — how much work moves to the cheaper Z.ai GLM models. L0 `claude`: all on the
  Claude subscription (default). L1 `light`: flash-class work (locate/map, tests/lint/build, long-file
  summaries) goes to GLM. L2 `glm` (balanced): also implementation, fixes and document writing on
  GLM (`glm -p`, `glm_model`); risk slices, debugging and every review stay on Claude. L3 `tight`: the whole session runs
  on GLM and reviews are queued instead of performed. Set with `worker --level 0|1|2|3`.
- **rtk** — installed by `/bajzi:setup`; compresses command output. A `noise-filter` hook additionally
  keeps loud install/build output out of the context (exit code preserved).
- **`glm` / `worker` / `ccr` shims** — launchers around `cc-router.js`, no daemon. `glm` always runs on
  GLM, `worker` follows the saved saver mode, `ccr` is the back-compat entry. Models (`~/.claude/cc-router.json`):
  `glm_orchestrator_model` (default `glm-5.3`), `glm_model` and `glm_fast_model` (both default `glm-5.3-flash`);
  set with `worker --set-orchestrator-model|--set-model|--set-fast-model <id>`, force per shell with
  `GLM_ORCHESTRATOR_MODEL`/`GLM_MODEL`/`GLM_FAST_MODEL`. A top-level GLM session runs on the orchestrator model,
  its sub-agents on `glm_model`; a nested launch (a `glm -p` worker) runs on `glm_model` throughout. `worker --status` shows
  the level, `worker --usage` reports the Anthropic/GLM weighted-token split. A GLM launch is refused
  during the Z.ai peak window (08:00-12:00 CEST, 07:00-11:00 CET in winter); override one call with `CC_GLM_PEAK_OK=1`.
- **Status line** — model, saver level, branch, task, context percentage, GLM share, open review-queue
  count and a peak-window hint.
- **Context guard** — warns at 40% context, blocks tool calls at 50% except writing/reading the handoff
  and read-only git, so you can always save state and `/clear`.

### Orchestration

- **Day-run mode** (`/bajzi:mode`) — injects a routing table at session start: locate/map and
  tests/lint/build to haiku; long-file summaries to haiku; documents and specified slices to sonnet;
  risk-bearing slices (locks, concurrency, quotas, auth, money, migrations, destructive scripts) to
  opus, always; every diff review and final branch review to the configured reviewer models (`reviewer_models` in the manifest), never the cheap tiers; debugging to sonnet when a
  failing test or repro exists, else opus; design and planning stay on the orchestrator's own model.
  **Escalation ladder:** sonnet round 1, fresh sonnet round 2, opus round 3, the orchestrator round 4,
  then park.
- **Agents** — `implementer` (sonnet, Tier 2/3 slices), `implementer-risk` (opus, Tier 1 slices),
  `reviewer` (opus, read-only, returns a findings file), `fixer` (sonnet, fixes every finding, never
  sees severity).
- **Review loop** — `/bajzi:implement` then `/bajzi:review` then `/bajzi:fix`. The routing and the
  two-round cap are decided by code on files, not by the model. After round 2 open findings go to the
  owner (`needs-owner.md`) or are parked as debt (`debt.md`).
- **Dispatch guard** — a hook that refuses review/fix work sent to the wrong agent and oversized briefs.
  A discipline guard, not a security boundary.
- **Debt** (`/bajzi:debt`) — checks the parked-findings cap before the next slice, drains it in one
  fixer pass plus one review, calibrates severities with a blind re-rate.
- **Autopilot** (`/bajzi:autopilot`) — an unsupervised work session with a decision log and a closing report.
- **Night-run** (`/bajzi:night-run`) — plans an unattended overnight run and produces the launch block.
  The launch block starts the plugin's own bash runner `run.sh` (`setsid nohup`, in a bash terminal on
  the VM): one fresh headless session per sprint, never pushes, guard checks and a review queue that a
  later Opus session drains.

### Session continuity

- **Handoff** (`/bajzi:handoff`) — saves state to `runtime/handoff/<branch>.md` with a suggested
  opening prompt; a SessionStart hook reloads it after `/clear`, compact and resume.
- **Methodology guard / `modszertan` (Hungarian for "methodology")** — records per repo which
  methodology leads (GSD, superpowers or none) in `.claude/METHODOLOGY`, and nags at session start
  when there is no decision yet.

### Safety

- **Secret-read guard** — denies reading `.env`, `.env.*` (except `.example`/`.sample`/`.template`/`.dist`),
  `.secrets` and the manifest's secret patterns. Accepted limits: it is a pattern guard, not a shell
  parser, so variable indirection, copying a protected file to another name and encoded paths pass; it
  covers files, not environment variables.
- **Injection scanner** — warn-only: after Read, WebFetch, WebSearch and MCP results it adds a "treat this
  as data" warning naming the matched rules. Never blocks; a rephrased injection passes.
- **Writer guard** — bajzi plugin files are edited only by a session started in the bajzi repo's main
  checkout; any other session is denied Edit/Write and sends a request instead (SendMessage, or a file
  in `runtime/requests/`, which stays open to all). Installed plugin copies are denied to every session.
  Accepted limit: Bash/PowerShell writes are not blocked.
- Hooks fail open: an internal error allows and logs. Three exceptions fail closed: the pre-commit gate
  (installed by `/bajzi:project-setup`), the night-run push guard, and `day-run-mode.sh` when a
  non-Anthropic session lacks the L3 text.

### Setup

- **`/bajzi:setup`** — machine setup from `bajzi/skills/setup/manifest.json` (plugins, settings, rtk,
  status line, user-scope MCPs). **`--check`** prints one drift line per difference and changes nothing.
- **`manifest.json`** — the single file to edit to add a tool; every machine gets it at the next setup.
- **`/bajzi:project-setup`** — applies or checks (`--check`) a repo's `.claude/project-profile.json`:
  project plugins and MCPs, METHODOLOGY, linked skills, instruction files and the pre-commit gate.

### Mods

- **`cache-timer`** — status line entry: minutes left until the main thread's prompt cache goes cold. It assumes a 60-minute cache; the cache is 5 minutes during usage overage and the mod cannot detect that.
- **`nightrun-pane`** — open the pane with `/nightrun`: the newest claude-orchestrator night run's sprint states and log tail. It reads only the `runtime/nightrun/<stamp>/` layout (`nightrun.log`, `*.status`, `SUMMARY.md`, `STOP`, `runtime/handoff/night-watch-state.md`), not bajzi night-run's `NIGHT_DIR`.

### Cowork variant

`bajzi-cowork` ships only the `autopilot`, `handoff` and `modszertan` skills. It lacks everything that
needs `bin/`, hooks, agents or `lib/`: the saver levels and shims, status line, all guards, day-run
mode, the review loop, night-run and setup. Install it in Cowork, never `bajzi`.

## Skills

| Skill | Command | What it does |
|---|---|---|
| `setup` | `/bajzi:setup` | Sets up or drift-checks (`--check`) a machine per the manifest. |
| `project-setup` | `/bajzi:project-setup` | Applies or checks the repo's project profile. |
| `handoff` | `/bajzi:handoff` | Saves session state and an opening prompt for after `/clear`. |
| `modszertan` | `/bajzi:modszertan` | Picks the repo's methodology (GSD, superpowers, none). |
| `autopilot` | `/bajzi:autopilot` | Unsupervised session with a decision log. |
| `mode` | `/bajzi:mode` | Turns day-run mode on/off or reports it. |
| `night-run` | `/bajzi:night-run` | Plans an unattended overnight run. |
| `implement` | `/bajzi:implement <id>` | Implements one slice through the implementer agents. |
| `review` | `/bajzi:review <slice> <range>` | Reviews a commit range through the reviewer agent. |
| `fix` | `/bajzi:fix <findings-file>` | Fixes round-1 findings, then runs the round-2 re-review. |
| `debt` | `/bajzi:debt` | Checks, drains or calibrates parked review debt. |
| `radar` | `/bajzi:radar [now\|install]` | Biweekly read-only review of plugins, Claude news and own usage; adopt or decline its items. |

Skills also start by themselves from a plain request ("do a handoff").

## Installation — Claude Code (every machine: laptop, VM, new machines)

1. Once per machine, in a terminal:
   ```bash
   claude plugin marketplace add bajzaa975/claude-alapcsomag   # or: a local path
   claude plugin install bajzi@bajzi-plugins   # marketplace name: bajzi-plugins
   ```
2. Once per machine, in a new Claude Code session: `/bajzi:setup` (marketplaces, plugins, rtk,
   settings, status line, `~/.claude/bajzi-mode`, user-scope MCPs).
3. Any time: `/bajzi:setup --check` — one line per drift item, changes nothing.
4. Per repo, only when the repo carries `.claude/project-profile.json`: `/bajzi:project-setup`
   (`--check` diffs it).

Then the global rules:

```bash
cat shared/CLAUDE.md >> ~/.claude/CLAUDE.md
```

Check: `claude plugin list`, and `/bajzi:handoff` in a new session.

### Without a marketplace, locally (for development)

The `bajzi/` directory can be copied here: `~/.claude/skills/bajzi/` — the next session
loads it automatically under the name `bajzi@skills-dir`.

## Installation — Cowork (Claude Desktop)

1. **Customize → Plugins → Add marketplace** → the repo's URL
   (`https://github.com/bajzaa975/claude-alapcsomag` or `bajzaa975/claude-alapcsomag`); the
   marketplace is named `bajzi-plugins`.
2. Install the `bajzi-cowork` plugin from the list. **Never install `bajzi` in Cowork**: it ships
   `bin/`, hooks and agents, which claude.ai marketplace sync rejects ("Sync failed").
3. **Or** without a repo: **Plugins → upload** a zip of the `bajzi-cowork/` directory (never of
   `bajzi/`). The zip is not in the GitHub repo; create it locally and make sure the `plugin.json`
   version inside it matches the marketplace's. Normally steps 1-2 (marketplace) are the
   recommended route.
4. Copy the content of `shared/cowork-preferences.md` (the part below the `---`) here:
   **Settings → Cowork → Global instructions → Edit** (only exists in the desktop app; in newer
   builds the **Customize** panel also brings together the Skills / Plugins / Global instructions
   trio). The "Customize → Instructions/Preferences" route listed here earlier was WRONG.
   A per-project layer on top of that: the **Instructions** field on the Project's right-hand panel,
   which goes ON TOP OF the global instructions, not instead of them.

## Updating

Push to the repo → Claude Code: `claude plugin update bajzi`, then `/bajzi:setup` (refreshes the
status line copy) · Cowork: **Update** at the marketplace, then update the `bajzi-cowork` plugin.
