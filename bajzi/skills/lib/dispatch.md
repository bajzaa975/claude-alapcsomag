# Dispatch template (shared by /bajzi:implement, /bajzi:review, /bajzi:fix, /bajzi:debt)

`FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"`, run from the repo root.

## One dispatch = four steps

1. **Write the brief** to `runtime/briefs/<slice>-<class>.txt` (Write tool). The brief carries the
   evidence inline — the spec, the diff, the findings copy, the test command. Never tell the agent
   to "read the brief/plan/review"; paste what it needs.
2. **Dispatch** with the Agent tool: `subagent_type: bajzi:<agent>`, `prompt` = the brief file's
   text verbatim, `description` = the row's description below (the dispatch guard classifies on it).
3. **Log** one line, whatever happened:
   `FC log <class> bajzi:<agent> runtime/briefs/<slice>-<class>.txt allow` (`deny` if the harness
   refused the dispatch). It appends the R4 TSV line `<ISO-UTC>\tSKILL-<CLASS>\t<agent>\t<chars>\t<allow|deny>`
   to `runtime/dispatch-sizes.log`; the `SKILL-` prefix keeps it apart from the hook's own line.
4. **Save the final message** verbatim where the row says (Write tool), before reading it.

| class | agent | description | brief = | final message saved to |
|---|---|---|---|---|
| implement | the `agent:` from `FC slice <id>` | `implement <slice>` | the slice file, verbatim | — (read DONE/BLOCKED) |
| review | reviewer | `review <slice> round 1` | the review brief below | `runtime/findings/<slice>-r1.md` |
| rereview | reviewer | `re-review <slice> round 2` | review brief + round-1 file + fixer report | `runtime/findings/<slice>-r2.md` |
| fix | fixer | `fix round <slice>` | fixer brief below | `runtime/findings/<slice>-r1.report.md` |
| drain-fix | fixer | `fix round debt` | fixer brief on `debt.fixer.md` | `runtime/findings/debt.report.md` |
| drain-review | reviewer | `re-review debt round 2` | rereview brief, slice `debt`, `debt.md` as the round-1 file | `runtime/findings/debt-r2.md` |
| calibrate | reviewer | `calibrate debt` | `Calibration mode.` + `debt.blind.md` | `runtime/findings/debt.rerate.txt` |

## Review brief

```
slice_id: <slice>   round: <1|2>   range: <base>..<tip>
GRAPH: use code-review-graph detect_changes_tool, then get_review_context_tool per changed symbol.
changed files:
<git diff --name-only <range>>
diff:
<git diff <range>>
[round 2: "round-1 findings:" + the r1 file, "fixer report:" + the report file]
```
A diff over 16 KB: send `git diff --stat` instead and say "read the changed files yourself"
(the dispatch guard caps a re-review brief at 24 KB).

## Fixer brief

```
slice_id: <slice>
files you may touch: <files: from the slice>
test command: <test: from the slice>
<the .fixer.md file, verbatim>
```
