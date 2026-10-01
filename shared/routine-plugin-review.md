# Plugin review

Layer (b), "has anything come out that is better than what I use?", is now part of
`/bajzi:radar` (biweekly local run, see docs/bajzi-package-spec.md). The old monthly prompt is retired.

## The machine layer (a)

`~/.local/bin/claude-plugin-check` — weekly systemd timer, reports only version drift of the
INSTALLED plugins, and speaks up via `update-monitor note` (Telegram + email).
It installs and updates nothing.

By hand: `claude-plugin-check` · report only on drift: `--quiet` · without alerting: `--no-note`
