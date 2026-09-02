---
name: setup
description: Set up a Claude Code machine to the desired state — plugin cleanup, then installation of the marketplaces, plugins, GSD, rtk and settings per the manifest. Use it ON A NEW MACHINE, or when an existing installation needs tidying up ("set up this machine", "clean out the plugins", "make it like my other machine").
---

# Machine setup per the manifest

The desired state **is in `manifest.json`, in this directory**. READ IT FIRST, and take
everything from there — not from this description, and not from your memory. If the manifest and
this file contradict each other, the manifest wins.

Work phase by phase, with a one-line status at the end of each phase. On Windows `~/.claude` is
`C:\Users\<user>\.claude`.

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

Collect and print terse: `claude plugin list`, `claude plugin marketplace list`,
the contents of `~/.claude/{skills,commands,agents,hooks}`, the
hooks/statusLine/enabledPlugins/permissions/skillOverrides blocks of `settings.json`, and whether GSD
is present (`~/.claude/.gsd-source`).

Mark every item: **NEEDED** (present in the manifest) or **TO DELETE**. Mark separately the ones on
the manifest's `deliberately_skipped` list — those are not missing by accident.

## PHASE C — Cleanup

1. **Foreign plugins:** `claude plugin uninstall <id>` for every plugin that is not on the manifest's
   `plugins` list. **Never delete by hand** under `~/.claude/plugins/` — `installed_plugins.json`
   would become inconsistent. Use only the CLI.
2. **Foreign marketplaces:** `claude plugin marketplace remove <name>`.
3. **Non-plugin skills/commands/agents:** under `~/.claude/{skills,commands,agents}`
   everything is to be deleted that is not `gsd-*` and was not installed by a plugin. **Pay special
   attention** to the names `alapcsomag`, `autopilot`, `handoff` and to `hooks/handoff-load.sh`: these
   are replaced by the `bajzi` plugin, both would load as duplicates. Before deleting, list what
   you are going to delete.
4. **settings.json:** remove the orphan hooks (pointing at non-existent scripts), the
   SessionStart entry calling `handoff-load.sh` (the plugin brings it), and the `skillOverrides`
   lines pointing at a deleted plugin. LEAVE the GSD hooks and the statusline ALONE.
   Back up first: `settings.json.bak-<date>`.
5. **Known leftovers:** based on the manifest's `known_leftovers` list. These are large,
   orphaned data directories — the list also contains the evidence of which tool they belong to.
6. **Do NOT clean up GSD by hand** — in phase D its own installer tidies itself up.

## PHASE D — Installation

1. Check: `claude --version`, `node -v`, and whether `bash` is on the PATH. **On Windows
   there is no bash without Git for Windows**, and the hooks silently do not run — report this.
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
4. **GSD:** interactive installer, **do NOT start it yourself**. Print the manifest's
   `gsd.install` command to the user, and what to choose at the prompts (`runtime`, `scope`,
   `profile`). Wait until they say it is done.
5. **Global rules:** per the manifest's `global_rules` field.
6. **settings.json merge:** the manifest's `settings_merge` object. Do not touch the GSD hooks and
   the statusline.
7. **rtk:** per the manifest's `rtk` block. Not required. Add the hook ONLY if
   the `check` command works.

## PHASE E — Verification, specifically for duplicates

- `claude plugin list` and `marketplace list` = exactly the manifest's content, nothing more
- there must be no name that exists both under `~/.claude/{commands,skills}` AND as a
  plugin skill (check separately: alapcsomag, autopilot, handoff)
- every `settings.json` hook command must point at an existing file
- tell them to start a new session and verify: `/bajzi:handoff` exists, `/context`
  baseline under 20%

## Closing report

Table: what was deleted · what was installed (with token cost) · what was left to manual work · where
the backup is. If something does not fit the categories above, **do not decide for the user** — put it
in the "manual" list.
