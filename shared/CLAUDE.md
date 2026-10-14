## Token budget (all projects)
1. **50% ceiling:** a session never goes above 50% of the context window. Above 40%, no new
   scope. Measure with `/context`.
2. **Use sub-agents:** repo exploration, multi-file reads and test/lint runs go into a sub-agent
   (Agent/Task tool); only a terse result reaches the main thread, never raw output.
3. **Files longer than ~300 lines stay out of the main thread** — use a sub-agent, or
   `rtk read -l aggressive`.
4. **Reference paths instead of pasting;** a project CLAUDE.md stays under 200 lines, details live
   in docs files.
5. **One task = one focused session;** exit the session at the end of the task (`/exit`).

## Context guard + handoff (all projects)
- After every closed subtask, update `runtime/handoff/<slug>.md`, where `/bajzi:handoff` derives
  `<slug>` from the current branch (`handoff-load.sh` resolves the same name). Keep it to at most
  40 lines: where we are, what is done, the exact next step, decisions and pitfalls, affected file
  paths. Create the directory if it does not exist. The `/bajzi:handoff` skill does this.
- At ~40% context (`/context`, or the CLI's "context low" indicator), do not start a new subtask:
  finish the current one, finalize the handoff file, then tell the user:
  **"Context above 40% — run /clear; the state needed to continue is loaded automatically from
  `runtime/handoff/<slug>.md`."**
- After `/clear` or compact, the `bajzi` plugin's SessionStart hook loads the handoff file; continue from
  there and do not re-read the whole repo.

## RTK — command output compression (only if installed)
- `rtk pytest` · `rtk ruff check` · `rtk err npm run build` · `rtk git status|log|diff` ·
  `rtk read <f>` · `rtk grep "p" .` · `rtk ls .` · `rtk find "*.py" .` · `rtk test <command>`
- Never run through rtk: deploy/release, ssh/scp, secret handling, DB migrations, state-changing
  git. If rtk is missing, everything runs raw; rtk is never a prerequisite.
- Under `sudo` use the full path (`/usr/bin/git`), otherwise you get "rtk: command not found".

## MCP hygiene
- For batch or automated runs: `claude --strict-mcp-config --mcp-config .mcp.json`.
- Review: use a code-graph MCP (graph build, then review context for the blast-radius files only).
- Symbol navigation: `find_symbol` / `get_function_source` instead of reading whole files.
