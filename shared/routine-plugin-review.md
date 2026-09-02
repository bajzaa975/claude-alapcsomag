# Monthly plugin review — ready-made routine prompt

This is layer (b): "has anything come out that is better than what I use?" This is judgment, not a script.

Setting it up in Claude Code: `/schedule` → monthly run, with this prompt. (Or by hand, at the
start of the month, in a separate session.)

---

```
Monthly plugin review. Work briefly, MAXIMUM 5 items at the end.

1. Read in the desired state:
   ~/.claude/plugins/marketplaces/bajzi-plugins/bajzi/skills/setup/manifest.json
   It contains the `plugins` list (what I use) AND the `deliberately_skipped` list
   together with WHY I skipped them. Do NOT recommend the skipped ones again, unless the
   reason for skipping is no longer valid — and then write down what changed.

2. Update and review the catalog:
   claude plugin marketplace update
   claude plugin list --json
   Then from the ~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json files
   look at what is on offer.

3. Report only what requires a DECISION:
   - a new plugin that would REPLACE one in my current set (say which one and how it is
     better), or that fills a gap the manifest does not cover
   - a plugin I use that is visibly abandoned (no update for a long time)
   - do NOT list what is unchanged; do not repeat last month's suggestions

4. SUPPLY CHAIN — for the installed THIRD-PARTY plugins (not mine, not the ones under
   anthropics/*). For each, look at the source repo and flag if it:
   - changed owner or maintainer (new owner, renamed repo, transferred access)
   - was archived, or has had no commit for months (abandoned — but its hooks still
     run code on my machine)
   - introduced a NEW hook type or MCP server compared to when it was installed
   - downloads and runs anything from the internet at runtime (e.g. claude-mem and Bun)
   This is not paranoia: plugin hooks run code on my machine in every session, so
   these repos are my machine's supply chain. If something is suspicious, WRITE IT UP, but do not fix it.

5. For every suggestion, give the token cost as well:
   claude plugin details <name>   (measurable after installation; if it is not installed, estimate
   from the number of skills, and say that it is an estimate)

6. Closing: if there is an acceptable suggestion, write EXACTLY how I would modify
   manifest.json (which line goes into the `plugins` or the `deliberately_skipped` list,
   with what `why` justification). Do NOT modify the file itself — that is my decision.
```

---

## The machine layer (a)

`~/.local/bin/claude-plugin-check` — weekly systemd timer, reports only version drift of the
INSTALLED plugins, and speaks up via `update-monitor note` (Telegram + email).
It installs and updates nothing.

By hand: `claude-plugin-check` · report only on drift: `--quiet` · without alerting: `--no-note`
