# bajzi-plugins — my own Claude Code / Cowork marketplace

A single plugin (`bajzi`) that gives the same working method in both environments. Five skills and two SessionStart hooks:

| Component | What it gives | Claude Code | Cowork |
|---|---|---|---|
| `alapcsomag` skill | token-efficient project layer (MCP, hook, HANDOFF skeleton) | ✅ | ✅ (MCP part skipped) |
| `autopilot` skill | unsupervised work session with a decision log | ✅ | ✅ |
| `handoff` skill | `runtime/HANDOFF.md` + suggested opening prompt | ✅ | ✅ |
| `modszertan` skill | per-repo METHODOLOGY marker (gsd/superpowers/none) | ✅ | ❌ — assumes a repo and a SessionStart hook |
| `setup` skill | machine setup per `manifest.json` | ✅ | ❌ — manages the Claude Code CLI's state |
| SessionStart hooks | HANDOFF reload after `/clear` + methodology guard | ✅ | depends on hooks being enabled |
| `shared/CLAUDE.md` | global token-budget rules | by hand into `~/.claude/CLAUDE.md` | `shared/cowork-preferences.md` → Global instructions |

Invoking the skills: `/bajzi:alapcsomag`, `/bajzi:autopilot`, `/bajzi:handoff`, `/bajzi:modszertan`,
`/bajzi:setup` — or simply
ask in words ("do a handoff"), they also start by themselves based on the description.

## Installation — Claude Code (laptop)

```bash
claude plugin marketplace add bajzaa975/claude-alapcsomag   # or: a local path
claude plugin install bajzi@bajzi-plugins
```

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
   (`https://github.com/bajzaa975/claude-alapcsomag` or `bajzaa975/claude-alapcsomag`).
2. Install the `bajzi` plugin from the list.
3. **Or** without a repo: **Plugins → upload** and select `bajzi-plugin.zip`.
   WARNING: because of `.gitignore` this zip is NOT in the GitHub repo — it is only created
   locally. If you need it, regenerate it in the repo root from the `bajzi/` directory, and make
   sure that the `plugin.json` version inside it matches the marketplace's.
   Normally steps 1-2 (marketplace) are the recommended route.
4. Copy the content of `shared/cowork-preferences.md` (the part below the `---`) here:
   **Settings → Cowork → Global instructions → Edit** (only exists in the desktop app; in newer
   builds the **Customize** panel also brings together the Skills / Plugins / Global instructions
   trio). The "Customize → Instructions/Preferences" route listed here earlier was WRONG.
   A per-project layer on top of that: the **Instructions** field on the Project's right-hand panel,
   which goes ON TOP OF the global instructions, not instead of them.

## Updating

Push to the repo → Claude Code: `claude plugin update bajzi` · Cowork: **Update** at the
marketplace, then update the plugin.
