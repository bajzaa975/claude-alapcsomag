---
name: project-setup
description: Apply or check this repo's project profile (.claude/project-profile.json) — project-scope plugins, project .mcp.json entries, .claude/METHODOLOGY, linked skills and instruction files. Use it when the user says "project-setup", "set up this repo from its profile", "apply the project profile", or with --check ("is this repo in sync with its profile").
---

# Project setup from the repo's profile

The project's desired state is `.claude/project-profile.json`, committed in the repo. bajzi
supplies only the mechanism, `${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js`. Never
edit the profile to make a run pass; if the profile is wrong, tell the user.

## `--check`

Run exactly:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js" --check
```

Print the output verbatim. Exit 0 = `project-setup --check: clean` (or no profile: nothing to do).
Exit 1 = one `DRIFT <kind> <target>` line per item. Exit 2 = the profile was REFUSED (unknown
key, newer version, invalid value): print the reasons, change nothing.

## Apply

1. `git status --short -- .mcp.json .claude/` — if those paths have uncommitted changes, stop
   and ask the user first.
2. Dry run, show the result:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js" --dry-run
   ```
3. Apply:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js"
   ```
   Exit 0 = applied. Exit 1 = the files were applied but a `claude plugin` command failed (the
   `FAILED` lines say which). Exit 2 = REFUSED, nothing was written.
4. Run the `--check` command above; it must print `project-setup --check: clean`.
5. Report the `APPLIED` lines. Do not commit; the user decides.

## Schema v1 (all keys optional)

```json
{ "version": 1,
  "methodology": "superpowers",
  "plugins": [{"id": "x@market", "marketplace": "owner/repo"}],
  "mcpServers": { "name": {"command": "...", "args": [], "type": "stdio"} },
  "skills": ["relative/path/in/repo"],
  "instructions": ["relative/path.md"] }
```

- `methodology` -> `.claude/METHODOLOGY` (`superpowers`, `gsd` or `none`).
- `plugins` -> `claude plugin marketplace add <marketplace>` when missing, then
  `claude plugin install <id> --scope project`.
- `mcpServers` -> merged into `.mcp.json`; entries not in the profile are never deleted. Use it
  for repos whose runner passes `--strict-mcp-config --mcp-config .mcp.json`; everything else
  gets its MCPs at user scope from `/bajzi:setup`.
- `skills` -> each directory is linked as `.claude/skills/<dirname>` (a junction on Windows).
- `instructions` -> an `@../<path>` import block in `.claude/CLAUDE.md`, between
  `<!-- bajzi:project-setup instructions begin/end -->` markers; text outside the block is kept.
