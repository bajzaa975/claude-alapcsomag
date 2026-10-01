---
name: radar
description: Biweekly read-only review of the owner's Claude setup (plugins and their supply chain, Anthropic/Claude Code news, methodology, the owner's own usage) - present the newest radar report and decide which items to adopt, run it now, or install the schedule. Use it on "/bajzi:radar", "/bajzi:radar now", "/bajzi:radar install", "what does the radar say", "review the radar report", "plugin review".
---

# /bajzi:radar [now | install]

`radar.js` (this directory) writes every file; the review itself runs headless with read-only
tools. State dir: `$BAJZI_RADAR_HOME`, else `~/.claude/bajzi/radar/` (reports in `reports/`,
`declined.md`, `.seen`, `.since`, `last-error.log`, `launch.js`).

## No argument: review the newest report

1. Read the newest `reports/*.md` in the state dir. None: say so and offer `/bajzi:radar now`.
   If `last-error.log` is newer than the newest report, show its first lines too.
2. Present the items tersely: one line each (title, category, effort), then ask which to adopt.
3. Append each DECLINED item to `<state>/declined.md`, one line: `<YYYY-MM-DD> | <title> | <reason>`
   (create the file if missing). The next radar run skips them.
4. Mark the report seen:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/radar/radar.js" seen
   ```
5. Adopted items become normal development work (plan, slice, review), never an edit made here.

## `now`: run it in the background

```
node "${CLAUDE_PLUGIN_ROOT}/skills/radar/radar.js" run
```

Start it in the background (it can take up to 40 minutes), tell the owner the report will land
in `<state>/reports/<date>.md`, and that the next session start announces it. On exit 1 it wrote
`<state>/last-error.log`.

## `install`: schedule it (every 2nd Monday 10:00)

Owner rung 1: show one approval line ("register the bajzi-radar scheduled task for the current
user, every 2nd Monday 10:00"), then run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/radar/radar.js" install-task
```

Windows: prints `NextRunTime: …`. Elsewhere it prints a crontab line; give it to the owner for
`crontab -e`.
