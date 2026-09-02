## Language (token efficiency)
- **Default: think in English AND answer in English**, even when I write in Hungarian.
  You do not need to mirror my language. The same content in Hungarian costs ~1.5-2x the output tokens.
- **Hungarian answers ONLY when I explicitly ask for it** — e.g. "write a Hungarian email",
  "answer in Hungarian", or when the deliverable itself is Hungarian-language text. In every other
  case English, even if the topic is Hungarian or I asked the question in Hungarian.
- **Everything you write and later read back must be in English:** `runtime/HANDOFF.md`
  (INCLUDING the "suggested opening prompt" block), memory files, commit messages,
  PR descriptions, code comments.
- When in doubt, English.

## Token budget (HARD rules — for every project)
1. **50% ceiling:** a session must NEVER go above 50% of the context window. Above 40% no new
   scope. Measure with `/context`.
2. **Sub-agents are REQUIRED:** repo exploration, multi-file reading, test/lint runs go into a
   sub-agent (Agent/Task tool); only a terse result reaches the main thread, never raw output.
3. **A file longer than ~300 lines does not go into the main thread** — sub-agent, or `rtk read -l aggressive`.
4. **Reference paths instead of pasting;** the project CLAUDE.md is ≤ 200 lines, details live in
   docs files.
5. **One task = one focused session;** the session exits at the end of the task (`/exit`).

## Context guard + HANDOFF (for every project)
- After every closed subtask, update `runtime/HANDOFF.md` (≤40 lines: where we are, what is
  done, the EXACT next step, decisions/pitfalls, affected file paths). Create the directory if it
  does not exist. That is what the `/bajzi:handoff` skill is for.
- When context reaches ~40% (`/context`, or the CLI's "context low" indicator), do NOT start a new
  subtask: finish the current one, finalize HANDOFF.md, then tell the user:
  **"Context above 40% — run /clear; the state needed to continue is loaded automatically from
  runtime/HANDOFF.md."**
- After `/clear` or compact, the `bajzi` plugin's SessionStart hook loads HANDOFF.md → continue from
  there, do NOT re-read the whole repo.

## RTK — command output compression (ONLY if installed)
- `rtk pytest` · `rtk ruff check` · `rtk err npm run build` · `rtk git status|log|diff` ·
  `rtk read <f>` · `rtk grep "p" .` · `rtk ls .` · `rtk find "*.py" .` · `rtk test <command>`
- NEVER run through rtk: deploy/release, ssh/scp, secret handling, DB migration, state-changing
  git. If rtk is missing, everything runs raw — RTK is never a prerequisite.
- Under `sudo` always use the full path (`/usr/bin/git`), otherwise you get "rtk: command not found".

## MCP hygiene
- For batch/automated runs: `claude --strict-mcp-config --mcp-config .mcp.json`.
- Review: code-review-graph (graph build → review context, blast-radius files only).
- Symbol navigation (token saver): `find_symbol`/`get_function_source` instead of whole files.
