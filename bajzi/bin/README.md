# bin/ — the cc-router shim

`cc-router.js` is a per-process model router for Claude Code: no proxy, no daemon, no
global settings. Thin launchers next to it (`worker`, `glm`, `ccr`) set `CC_ROUTER_ENTRY`
and run this file. `worker ...` follows the saver switch (`claude|light` = plain Claude
subscription, `glm|tight` = Z.ai GLM); `glm ...` is always GLM; `ccr code ...` keeps the
old claude-code-router launcher working (`--model deepseek-*` goes to DeepSeek, everything
else to GLM). In GLM mode the Claude aliases are remapped so callers never change their
arguments: `--model sonnet|opus` -> `glm_model`, `--model haiku` -> `glm_fast_model`.

Admin commands (run via `worker`): `--level 0|1|2|3` (0 claude, 1 light, 2 glm, 3 tight),
`--set claude|light|glm|tight`, `--status`, `--set-model <id>`, `--set-fast-model <id>`,
`--log [n]`, `--usage [since] [--until <t>] [--json]`. Anything else is passed to Claude
Code unchanged. State lives under `~/.claude`: `worker-mode` (the level word),
`cc-router.json` (models), `cc-router.log`.

## install.sh

`bash bajzi/bin/install.sh` runs the shim's tests first (`node --test` on
`bajzi/bin/tests/`) and copies `cc-router.js` over `~/.local/bin/cc-router.js` only when
they pass, keeping the previous copy as `~/.local/bin/cc-router.js.bak`.

## Environment variables

- `CC_WORKER_MODE` — force the worker mode for THIS shell, overriding
  `~/.claude/worker-mode` (one of `claude|light|glm|tight`; anything else exits 64).
- `CC_GLM_PEAK_OK=1` — bypass the GLM peak-window refusal. Without it, a GLM-bound launch
  inside the Z.ai peak window (06:00-10:00 UTC = 14:00-18:00 UTC+8, 3x quota) is refused
  with exit 75 and one line is appended to the peak log.
- `CC_ROUTER_WORKER=1` — set by the shim on every Claude process it spawns from inside a
  Claude session, so the bajzi hooks can tell a spawned `glm -p` worker session from the
  interactive one (the GLM-WORKER block instead of a saver level).
- `CC_ROUTER_NOW` — freeze the clock for tests: the peak-window check reads this instead
  of the real time (any value `new Date()` accepts; a garbage value falls back to now).
- `CC_PEAK_LOG` — where peak refusals are appended (default
  `~/.claude/glm-peak-refusals.log`); the routing-violation counter reads the same file.
- `CC_CLAUDE_PREFIX_ARGS` — JSON array of args inserted before the real claude arguments.
  Test seam; inert when unset, and bad JSON or a non-array is ignored.
