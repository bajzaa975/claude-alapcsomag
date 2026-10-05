# bin/ — the cc-router shim

`cc-router.js` is a per-process model router for Claude Code: no proxy, no daemon, no
global settings. Thin launchers next to it (`worker`, `glm`, `ccr`) set `CC_ROUTER_ENTRY`
and run this file. `worker ...` follows the saver switch (`claude|light` = plain Claude
subscription, `glm|tight` = Z.ai GLM); `glm ...` is always GLM; `ccr code ...` keeps the
old claude-code-router launcher working (`--model deepseek-*` goes to DeepSeek, everything
else to GLM). In GLM mode the Claude aliases are remapped so callers never change their
arguments: `--model sonnet|opus` -> `glm_model`, `--model haiku` -> `glm_fast_model`.

Admin commands (run via `worker`): `--level 0|1|2|3 [--global]` (0 claude, 1 light, 2 glm,
3 tight), `--set claude|light|glm|tight [--global]`, `--status`, `--set-model <id>`,
`--set-fast-model <id>`, `--log [n]`, `--usage [since] [--until <t>] [--json]`. Anything else
is passed to Claude Code unchanged. State lives under `~/.claude`: `worker-mode` (the machine
default level word), `cc-router.json` (models), `cc-router.log`.

The level is per session when set from inside a session. `--level`/`--set` run from a Claude
Code session's Bash/PowerShell tool (`CLAUDE_CODE_SESSION_ID` set) write only
`~/.claude/bajzi/sessions/<session id>.level` (`BAJZI_STATUS_DIR` overrides the dir), so other
running sessions keep their level. To change the machine default, add `--global`, or run the
command from a plain shell; sessions that set their own level keep it. Resolution, for launches
and `--status`: `CC_WORKER_MODE` > the session file > `BAJZI_SESSION_LEVEL` (inherited by a launched child, never opens the saver gate) > `worker-mode` > `claude`; `--status` names
the source.

## install.sh

`bash bajzi/bin/install.sh` runs the shim's tests first (`node --test
bajzi/bin/tests/cc-router.test.js`) and, only when they pass, copies `cc-router.js` and the six
launchers in `launchers/` (`worker`, `glm`, `ccr` + `.cmd` twins) into `~/.local/bin`. An
identical destination is left untouched; a different one is kept as `<name>.bak` first. The
launchers are tracked byte-for-byte (`.gitattributes`: `-text`), so edit them here, not in
`~/.local/bin`. `tests/install.test.js` exercises the installer against a decoy `HOME`.

## Environment variables

- `CC_WORKER_MODE` — force the worker mode for THIS shell, overriding the session level file
  and `~/.claude/worker-mode` (one of `claude|light|glm|tight`; anything else exits 64).
- `CLAUDE_CODE_SESSION_ID` — exported by Claude Code to its tool processes; selects the
  session level file. An id outside `^[A-Za-z0-9_-]{1,128}$` counts as no session.
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
