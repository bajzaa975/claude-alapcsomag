---
name: alapcsomag
description: Install the token-efficient base package into this project — MCP layer (code-review-graph, token-savior), context-guard hook and runtime/HANDOFF.md skeleton. Use it when the user says "alapcsomag", "base package", "set up the project", "token-efficient setup", or starts working in a new repo.
---

# Token-efficient base package — project layer

Install the project layer of the token-efficient base package into this project. Every step must be
IDEMPOTENT: extend an existing file, do not overwrite it; leave finished items alone. A terse report at the end.

**First determine what environment you are running in** (is there a Bash tool, is there a repo root):
- **Claude Code** (Bash + repo): steps 1-6 all apply.
- **Cowork / Desktop** (no shell or no git repo): SKIP steps 1 and 4 —
  there the MCP connectors are handled by the plugin or by Customize → Connectors, not by the repo's
  `.mcp.json`. Steps 2-4 and 6 must be done there too.

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
            "command": "b=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); s=$(printf %s \"${b:-default}\" | tr A-Z a-z | sed -e s/[^a-z0-9._-]/-/g -e s/--*/-/g); cat \"runtime/handoff/${s:-default}.md\" 2>/dev/null || cat runtime/HANDOFF.md 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

## 3. Handover skeleton

Handovers are session scratch and MUST NOT be committed. `runtime/` is created here, so this step
also owns the ignore rule.

1. Create `runtime/handoff/` if it is missing.
2. If `.gitignore` does not already cover it, append `runtime/` to `.gitignore`. Idempotent —
   check with `git check-ignore -q runtime/HANDOFF.md` before adding anything.
3. Do NOT pre-create an empty handover file. `/bajzi:handoff` writes
   `runtime/handoff/<branch-slug>.md` at close-out; an empty skeleton lying around only gets
   loaded by the SessionStart hook and wastes context. The structure it will use:

```markdown
# HANDOFF — session continuation
Updated: <date> · Task: <the session's goal in one sentence>
Owner-session: <session name and ref>
## Where we are
## Done
## NEXT STEP (exactly, start with this)
## Decisions / pitfalls
## Affected files (paths)
## SUGGESTED OPENING PROMPT
```

## 4. Human-instruction rule in the project's CLAUDE.md

Idempotent: if the project's `CLAUDE.md` does not already contain a
`## Instructions for me (the human)` heading, append this section verbatim. Do not reword it.

```markdown
## Instructions for me (the human)
When a step is MINE to do, not yours, never write a vague one-liner and never
assume I am an expert in GitHub, git, networking, PowerShell, OCI, DNS or cloud
consoles. I am not — that is why I use this tool. Every human step must state:
- Where: which machine, and which shell (bash / PowerShell / the Claude Code
  prompt with `!`), or which website.
- The exact command, in a copyable code block, one per line, with the working
  directory shown.
- Web UI = click-by-click: the URL to open, then each menu/tab/button by its
  VISIBLE label, and what the screen looks like when it worked.
- Success criteria, plus the single likeliest failure and its fix.
- Imperative, numbered steps — no "you may want to" / "consider".
- Never ask me for a parameter you can determine yourself; fill it in and say
  where it came from.
When there is MORE THAN ONE thing for me to do, do not scatter it through prose:
produce ONE numbered checklist, publish it as an Artifact and give me the link —
five prompts later I cannot find a list with PgUp. Update that same Artifact as
items get done; do not post a new list.
```

## 5. Environment check

`echo $ANTHROPIC_BASE_URL` — if a proxy/FCC is configured, native MCP tool search is TURNED OFF
(all schemas are preloaded): point out that in that case batch runs require
`--strict-mcp-config --mcp-config .mcp.json`, and there should be few MCP servers.

## 6. Verification

The two MCPs start (`uvx … --help`); point out that the MCP/hook change takes effect at the NEXT
session start; in a new session `/context` baseline < 20%, `/mcp` clean.
Terse closing report: what was done, what was left to manual work.
