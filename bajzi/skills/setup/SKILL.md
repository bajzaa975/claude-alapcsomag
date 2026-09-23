---
name: setup
description: Set up a Claude Code machine to the desired state, or only check it for drift — plugin cleanup, then marketplaces, plugins, rtk, settings, the bajzi status line and user-scope MCPs per the manifest. Use it ON A NEW MACHINE, when an existing installation needs tidying up ("set up this machine", "clean out the plugins", "make it like my other machine"), or with --check ("is this machine in sync", "setup --check").
---

# Machine setup per the manifest

The desired state **is in `manifest.json`, in this directory**. READ IT FIRST, and take
everything from there — not from this description, and not from your memory. If the manifest and
this file contradict each other, the manifest wins.

Work phase by phase, with a one-line status at the end of each phase. On Windows `~/.claude` is
`C:\Users\<user>\.claude`.

## `--check`: report drift, change nothing

If the user invoked `/bajzi:setup --check` (or asked only whether the machine is in sync), run
exactly this and nothing else:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/setup/check.js"
```

Print its output verbatim. Exit 0 = `setup --check: clean`. Exit 1 = one `DRIFT <id> <detail>`
line per item. Exit 2 = the manifest could not be read. Fix nothing in this mode; offer a full
`/bajzi:setup` run when there is drift.

## Blocklist

**Never touch** the paths listed in the manifest's `deletion_blocklist` array, not even
when the task is "cleanup". These do not come back after deletion: logout, session
history, memory. If you are unsure about a file: do NOT delete it, put it in the report as "manual".

## PHASE A — Backup (start with this, skipping is forbidden)

```
tar -czf ~/claude-backup-$(date +%Y%m%d-%H%M).tgz -C ~ \
  --exclude='.claude/plugins/cache' --exclude='.claude/shell-snapshots' \
  --exclude='.claude/file-history' --exclude='.claude/paste-cache' .claude
```

Print the backup's path and size. On native Windows, if there is no `tar`: copy the directory
as `~/.claude-backup-<date>`, and report this.

## PHASE B — Inventory, BEFORE deleting anything

Collect and print terse: `claude plugin list`, `claude plugin marketplace list`, `claude mcp list`,
the contents of `~/.claude/{skills,commands,agents,hooks}`, the
hooks/statusLine/enabledPlugins/permissions/skillOverrides blocks of `settings.json`, and the
output of `node "${CLAUDE_PLUGIN_ROOT}/skills/setup/check.js"`.

Mark every item: **NEEDED** (present in the manifest) or **TO DELETE**. Mark separately the ones on
the manifest's `deliberately_skipped` list — those are not missing by accident. Every `leftover`
and `leftover-setting` line of the check output is **TO MOVE** (PHASE C step 6).

## PHASE C — Cleanup

1. **Foreign plugins:** `claude plugin uninstall <id>` for every plugin that is not on the manifest's
   `plugins` list. **Never delete by hand** under `~/.claude/plugins/` — `installed_plugins.json`
   would become inconsistent. Use only the CLI.
2. **Foreign marketplaces:** `claude plugin marketplace remove <name>`.
3. **Non-plugin skills/commands/agents:** under `~/.claude/{skills,commands,agents}`
   everything is to be deleted that was not installed by a plugin. **Pay special
   attention** to the names `alapcsomag`, `autopilot`, `handoff` and to `hooks/handoff-load.sh`: these
   are replaced by the `bajzi` plugin, both would load as duplicates. Before deleting, list what
   you are going to delete.
4. **settings.json:** remove the orphan hooks (pointing at non-existent scripts), the
   SessionStart entry calling `handoff-load.sh` (the plugin brings it), the `skillOverrides`
   lines pointing at a deleted plugin, and every hook command or `permissions.allow` entry that
   contains one of the manifest's `forbidden_leftovers.settings_substrings`.
   Back up first: `settings.json.bak-<date>`.
5. **Known leftovers:** based on the manifest's `known_leftovers` list. These are large,
   orphaned data directories — the list also contains the evidence of which tool they belong to.
6. **Forbidden leftovers (GSD is retired, `gsd.status`):** list every path the check reported as
   `leftover`. Only after the user confirms IN THIS CHAT, MOVE (never delete) them to
   `~/claude-backup-leftovers-<date>/`, keeping each path relative to `~`. Without that
   confirmation leave them and put them in the "manual" list. While the manifest still has
   `gsd.laptop_retained_hooks`, never move the files it lists (on the owner's laptop only):
   report them as "manual" instead.

## PHASE D — Installation

1. Check: `claude --version`, `node -v` (must be >= 18: the status line and the guards are node),
   and whether `bash` is on the PATH. **On Windows there is no bash without Git for Windows**, and
   the shell hooks silently do not run — report this.
2. The manifest's `marketplaces` list: `claude plugin marketplace add <source>`.
3. The manifest's `plugins` list:
   - not yet installed: `claude plugin install <id>`
   - **already installed: `claude plugin update <name>`** — setup does not only install, it also
     brings things up to date. The update takes effect at the next session start.
   After each item `claude plugin details <name>` — put the token cost into the report.

   **NEVER RE-ENABLE A DELIBERATELY DISABLED PLUGIN.** If `claude plugin list`
   says a plugin is `disabled`, leave it that way, and write in the report that it stayed disabled.
   This skill does NOT use the `claude plugin enable` command. If the manifest's entry has a
   `windows` field and you are running on this platform, read it and follow it — that is where it is
   written which plugin is known to be problematic and what to do.
4. **GSD:** never install it (`gsd.default_install` is `false`, `gsd.status` says retired).
5. **Global rules:** per the manifest's `global_rules` field.
6. **settings.json merge:** the manifest's `settings_merge` object.
7. **rtk:** per the manifest's `rtk` block. Not required. Add the hook ONLY if
   the `check` command works. Then make sure the rtk config file (`rtk.config`, per OS) has every
   entry of `rtk.exclude_commands` in `[hooks] exclude_commands`, keeping entries already there.
8. **Default working mode:** if `~/.claude/bajzi-mode` does not already exist, create it with
   `day-run` — never overwrite an existing choice:
   ```
   [ -e "$HOME/.claude/bajzi-mode" ] || { mkdir -p "$HOME/.claude"; printf 'day-run\n' > "$HOME/.claude/bajzi-mode"; }
   ```
   This is what makes the plugin's day-run injection safe: the owner's machines opt in, a
   stranger's machine stays silent.
9. **Status line** (every run, it refreshes the copy):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/setup/install-statusline.js"
   ```
   It copies the status line to `~/.claude/bajzi/` and points `settings.json` `statusLine` at that
   copy, backing `settings.json` up as `settings.json.bak-bajzi-<stamp>` first. Never write the
   plugin cache path into settings yourself. If it prints `FAILED`, report the message and go on.
10. **User-scope MCPs:** for every entry of the manifest's `user_mcps` object that `claude mcp list`
    does not show, add it with the entry as JSON (Git Bash / Linux quoting shown):
    ```
    claude mcp add-json --scope user <name> '<the user_mcps entry as one-line JSON>'
    ```

## PHASE E — Verification, specifically for duplicates

- `node "${CLAUDE_PLUGIN_ROOT}/skills/setup/check.js"` prints `setup --check: clean`. Every
  remaining `DRIFT` line goes into the report with the reason it stayed.
- there must be no name that exists both under `~/.claude/{commands,skills}` AND as a
  plugin skill (check separately: alapcsomag, autopilot, handoff)
- every `settings.json` hook command must point at an existing file
- tell them to start a new session and verify: the status line shows `L<n>` and the context bar,
  `/bajzi:handoff` exists, `/context` baseline under 20%, `/bajzi:mode status` reports the mode set
  in PHASE D step 8 (or an existing choice, left untouched)

## Closing report

Table: what was deleted · what was moved · what was installed (with token cost) · what was left to
manual work · where the backup is. If something does not fit the categories above, **do not decide
for the user** — put it in the "manual" list.
