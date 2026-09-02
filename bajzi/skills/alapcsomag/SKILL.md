---
name: alapcsomag
description: Install the token-efficient base package into this project — MCP layer (code-review-graph, token-savior), context-guard hook and runtime/HANDOFF.md skeleton. Use it when the user says "alapcsomag", "base package", "set up the project", "token-efficient setup", or starts working in a new repo.
---

# Token-efficient base package — project layer

Install the project layer of the token-efficient base package into this project. Every step must be
IDEMPOTENT: extend an existing file, do not overwrite it; leave finished items alone. A terse report at the end.

**First determine what environment you are running in** (is there a Bash tool, is there a repo root):
- **Claude Code** (Bash + repo): steps 1-5 all apply.
- **Cowork / Desktop** (no shell or no git repo): SKIP steps 1 and 4 —
  there the MCP connectors are handled by the plugin or by Customize → Connectors, not by the repo's
  `.mcp.json`. Steps 2-3 and 5 must be done there too.

---

## 1. `.mcp.json` in the repo root

If it exists, extend it; `<REPO>` = the output of `pwd`.
Prerequisite: `uvx` (if missing: `curl -LsSf https://astral.sh/uv/install.sh | sh`).

```json
{
  "mcpServers": {
    "code-review-graph": {
      "command": "uvx",
      "args": ["--python", "3.13", "better-code-review-graph"],
      "type": "stdio"
    },
    "token-savior": {
      "command": "uvx",
      "args": ["--from", "token-savior-recall[memory-vector]", "--with", "mcp", "token-savior"],
      "env": {
        "TOKEN_SAVIOR_CLIENT": "claude-code",
        "TOKEN_SAVIOR_PROFILE": "optimized",
        "WORKSPACE_ROOTS": "<REPO>"
      },
      "type": "stdio"
    }
  }
}
```

## 2. Context-guard hook — `.claude/settings.json` in the repo (merged into the existing one)

This only needs to be set up separately if the `bajzi` plugin is not installed (the plugin's own
SessionStart hook does more than this: it also prints the suggested opening prompt).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "cat runtime/HANDOFF.md 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

## 3. HANDOFF skeleton

`runtime/HANDOFF.md` (if missing) + `runtime/` should go into `.gitignore` if the team does not
want to version it:

```markdown
# HANDOFF — session continuation
Updated: <date> · Task: <the session's goal in one sentence>
## Where we are
## Done
## NEXT STEP (exactly, start with this)
## Decisions / pitfalls
## Affected files (paths)
## SUGGESTED OPENING PROMPT
```

## 4. Environment check

`echo $ANTHROPIC_BASE_URL` — if a proxy/FCC is configured, native MCP tool search is TURNED OFF
(all schemas are preloaded): point out that in that case batch runs require
`--strict-mcp-config --mcp-config .mcp.json`, and there should be few MCP servers.

## 5. Verification

The two MCPs start (`uvx … --help`); point out that the MCP/hook change takes effect at the NEXT
session start; in a new session `/context` baseline < 20%, `/mcp` clean.
Terse closing report: what was done, what was left to manual work.
