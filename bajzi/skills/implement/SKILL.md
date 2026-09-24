---
name: implement
description: Implement one slice from runtime/slices/<id>.md through the bajzi implementer agents (Tier 1 -> implementer-risk on opus, else implementer), then commit it for review. Use it when the user says "/bajzi:implement <id>", "implement slice <id>", or a plan step names a slice file.
---

# /bajzi:implement <slice-id>

You orchestrate; the agent writes the code. `FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"` (repo root); the dispatch steps: `${CLAUDE_PLUGIN_ROOT}/skills/lib/dispatch.md` (read it once).

1. `FC check` — exit 4 = DEBT CAP HIT: print its output and STOP. The slice does not start until
   `/bajzi:debt --drain` brings the debt under the cap (D6). Any other non-zero exit: print, STOP.
2. `FC slice "<slice-id>"` — prints `agent:`, `tier:`, `files:`, `test:`. Exit 2 = a bad slice
   file or id (`docs/slice-format.md`): print the error, STOP. The agent is this lookup, never your choice.
3. `base=$(git rev-parse HEAD)`; no tracked file may be modified
   (`git status --porcelain --untracked-files=no` empty), else STOP.
4. Dispatch per dispatch.md, class `implement`, brief = the slice file verbatim, nothing else.
   A guard deny -> print the reason and its rule id, STOP.
5. `SLICE <id> BLOCKED: ...` -> print it, STOP. `SLICE <id> DONE` -> every file in its list, and every
   path in `git status --porcelain --untracked-files=no`, must be in `files:`; else STOP, commit nothing.
6. Run the `test:` command; red -> STOP and report. Green -> `git add -- <each listed file>`
   (never `-A`), `git commit -m "<slice-id>: implement"`.
7. `tip=$(git rev-parse HEAD)`; print `range: <base>..<tip>` (both full SHAs) and the next step:
   `/bajzi:review <slice-id> <base>..<tip>`.
