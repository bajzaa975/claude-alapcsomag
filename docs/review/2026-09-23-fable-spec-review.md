# bajzi-package-spec.md — second-opinion review (Fable, 2026-09-23)

Reviewed: the full spec (§0–§11, 1,456 lines at the §11-pinned commits) plus two external model reviews the owner supplied. Findings below are the ones the external reviews missed, then a verdict on those reviews, then tooling gaps, then the review-cadence question.

## Bottom line

The spec is unusually good as a document, and the CTQ (both providers in one session, no router daemon) is met. Two things dominate everything else:

1. **The security model assumes a write boundary that a single-user Windows laptop does not have.** "Pinned guard set in a location no session can write" is not achievable by path convention when the session runs as the owner's user with `bypassPermissions`. It needs OS-level separation (container / second user), not a better deny list. Until then, the owner decision "no night run" is correct.
2. **The review cadence is tuned for guard code and is being applied to application code.** Per-slice Opus review with 2-round fix loops is the right price for `review_queue.py`; it is the wrong price for a CRUD screen.

## Findings the external reviews missed

**F1 — The pinned guard set cannot be "unwritable" without privilege separation (structural; blocks P2).** With `bypassPermissions` a session can `Copy-Item` over `~/.local/bin/cc-router.js`, `~/.claude/settings.json`, the plugin cache hooks, `$PROFILE`, or the pinned set itself — the only obstacle is a 67-entry path-pattern deny list, which by the spec's own taxonomy is a discipline guard, not a boundary. Options, cheapest first: night sessions inside a Docker/devcontainer (Anthropic's reference devcontainer has an egress firewall) with only the repo mounted and the guard set on the host; a dedicated low-privilege Windows user for sessions with NTFS ACLs on the guard set; WSL2 + Claude Code's own sandbox mode (bubblewrap on Linux; not Windows as far as I know — verify). Design §9.3 around that; the `.pth`, C-1 and C-2 rows then mostly fall out for free.

**F2 — Invariant 8's 30-minute margin is only enforced by the runner.** `peakOpen()` refuses only *inside* the window (UTC hour 6–9). An interactive session dispatching `glm -p` at 05:40 UTC runs into 3x billing with no kill. Add the margin to the shim (one constant) or downgrade Invariant 8 to a night-run-only property.

**F3 — The Z.ai key is in the session's own process environment; the secret guard cannot protect it.** In a GLM session it is `ANTHROPIC_AUTH_TOKEN`; on Windows `ZAI_API_KEY` is a User env var visible to `Get-ChildItem Env:` in every session. Model 1's P1 (`cc-router.env` pattern) is correct but closes only the file path. Add an accepted-limits line in §9.1; rotate the key rather than pretend the read guard covers it.

**F4 — Routing-counter excuse window is wrong-shaped.** It excuses a Claude fallback for 10 minutes after a logged refusal, but the peak window is 4 hours. A session that sensibly stops trying GLM after the first refusal is logged as violating for the remaining ~3h50m. Excuse by clock (`date -u +%H` in 6–9), not by log recency. Log noise only, but it makes `routing-violations.log` untrustworthy exactly when it would be read.

**F5 — The Claude Code CLI version is not pinned anywhere in §11.** At least five behaviours depend on it: hook JSON shapes, the "`Write(...)` deny is ignored, only `Edit` counts" quirk, `--settings` semantics, `rate_limit_event` record format, `remaining_percentage` in the status-line input. A CLI update can silently flip deny-list semantics under a night run. Add a §11 row; make preflight refuse an unknown version.

**F6 — Hard kill during `git commit` leaves `index.lock`.** `-MaxHours` and the idle kill are `taskkill /F /T`; the next preflight's "tracked tree clean" or the tripwire then fails for the wrong reason. Add an `index.lock` age check to `finally`.

**F7 — Night runner is Windows-only, but §1's purpose is "several machines behave identically" including the Linux VM.** Either state night runs are laptop-only by design, or plan the bash/systemd port. Given F1, the Linux side is where sandboxing is easiest — the port and the guard-set design may be the same project.

**F8 — `claude-opus-5-5` is hard-pinned in at least five places across two repos** (DRAIN_MODEL, `rq:35`, DAY-RUN-RULES, plan constraints, CLAUDE.md); the drain verdict requires an exact match. The exact pin is a legitimate anti-downgrade property, but it needs one source (the pinned set's config) and a change-map row, or the next Opus release breaks drains non-obviously.

**F9 — Line-number anchors.** 200+ `file:line` pins on three moving commits is a maintenance tax that will stop being paid within a month, after which the doc lies in the most confident-looking way. Keep `file:function`, drop `:line`; `code-review-graph` exists precisely so a reader can find the function.

**Smaller:** `head -80` cap on DAY-RUN-RULES.md needs a test asserting line count < 80. `--model deepseek-*` is an untested path in a Tier-1 file — delete or test. The change map is ~90% Tier 1, which is right for this repo but confirms the tier system alone will not reduce review load on application repos.

## On the two external reviews

**Model 1** is the useful one. P1–P7 are all real; agree with its priority order except that P2 needs F1's reframing (not "build the set" but "get an OS boundary first"). OSS list: `ccusage` yes, as a cross-check on the weighted-share metric. `task-master`, `claude-squad`/`crystal`, `vibe-kanban`, `spec-kit`: no — they duplicate the orchestrator already built. `claude-code-security-review` assumes a PR flow not in use; local `semgrep` in the gate does the same job.

**Model 2** is mostly praise; of its three suggestions two are wrong here. Worktree isolation for GLM sub-agents: the `--concurrent` batch already corrupted the main tree and needed union-merge hacks — do not reintroduce that for sub-agents. AST-based complexity pre-routing: the right routing axis is *risk class* (already assigned by the plan), not complexity. The third ("GLM must call lint/typecheck MCPs before returning") has the right instinct and the wrong mechanism: a "model must call X" rule is a discipline rule that fails open. Make it the gate, not an MCP.

## Tooling gaps worth closing

- **Pre-commit mechanical gate on the write side**: `ruff` + `pyright`/`mypy`, `eslint` + `tsc`, and **`gitleaks`** (there is a read-side secret guard and no write-side one — a GLM session can still commit a key). Run via the existing `.githooks/pre-commit`; no model sees code that fails it. Single biggest reducer of review rounds.
- **`semgrep`** with a small ruleset for Tier-1 change classes (subprocess/shell, path handling, auth) as the automated first pass before Opus.
- **A container or second user for night sessions** (F1) — the reference devcontainer is the least work.
- **A peak-window parity test** across shim/runner/display, in the style of `saver-level-parity.sh`.
- **One test entrypoint** (`just`, works on Windows) wrapping §3's nine commands in three shells — the table itself is a drift source.
- **Launchers into the repo**, installed by `install.sh` (Model 1's P5; ~30 min).

## Review cadence

Per-slice review with small fix loops is the bottleneck, and it does not buy proportional quality. Every round is a fresh sub-agent that reloads the diff and graph context, so the *fixed* cost per round dwarfs the per-finding cost; small rounds pay it many times, batching amortizes it. The night-run design already accepts this (`BUILT` + drain = batched review debt); the day-run flow never got the same treatment.

Caveat: per-slice review buys *early* catch of structural mistakes — a wrong interface in slice 2 propagates into slices 3–10. So early review moves to the one place it is cheap and high-leverage: **the plan and the interfaces, before implementation.**

| Layer | When | Who | Cost |
|---|---|---|---|
| Design/interface review | Once per milestone, before code | Opus, main thread | Small; highest leverage |
| Mechanical gate | Every commit (pre-commit) | lint/type/tests/gitleaks/semgrep | Zero model tokens |
| Slice review | **Tier 1 slices only** (guards, auth, money, locks, migrations, ≥3-file structural) | Opus, 2-round cap stays | As today, for ~20% of slices |
| Tier 2/3 slices | No model review; gate + GLM self-check; findings accumulate | — | — |
| Milestone review | Once per milestone, whole branch, graph-scoped, split by module to keep each dispatch ≤ ~1,500 changed lines | Opus (optional GLM pre-pass whose findings Opus adjudicates — the existing Tier 2 shape) | One big round instead of N small |
| Milestone fix | One batched fix sprint from a severity-tagged findings file; blockers immediately, minors batched or accepted; 2-round cap at *this* level | GLM at L2 | — |

"Two models per milestone" is worth it only asymmetrically — GLM as a recall booster whose findings Opus adjudicates, never a second opinion of equal weight (Invariant 4).

Two spec consequences of batching:
- **Dispatch guard R2/R3 are tuned for small rounds.** A milestone fix round with 15 findings will not fit in 6,000 chars inline, and R2 denies the fixer reading a review file. Add an allowed *findings file* format (structured, `file:line · severity · finding · test`, size-capped) as the one document a fixer may read, or split the fix round into per-module dispatches.
- **"Where the review found the error"** lives in that findings file, not in the graph — the graph gives the reviewer context; it is not a store the fixer can consume deterministically.

Expected effect: a milestone of ~10 slices with 2 Tier-1 slices goes from ~20 review + 20 fix dispatches to ~4 + 4 + one design pass. Tier-1 quality unchanged; on Tier 2/3 the mechanical gate catches what the small rounds were mostly catching.

## Suggested order

1. Model 1's P1 + m1 pipe rule + launchers into repo.
2. Pre-commit mechanical gate with gitleaks (this is what makes the cadence change safe).
3. Cadence change + findings-file format + R2/R3 adaptation in spec and dispatch guard.
4. Dispatch-guard merge, `env-unify` 1.8.0, GSD migration — so §1–§10 stop describing a system that is not installed.
5. F1: pick the OS boundary (container vs second user), *then* design the pinned set and §9.3 against it. No night run before that.

Not to touch: the two-round cap, the L3/BUILT/drain design, the fail-closed push guard.
