# Dispatch template (shared by /bajzi:implement, /bajzi:review, /bajzi:fix, /bajzi:debt)

`FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"`, run from the repo root. Quote every
argument you pass to it or to git (`"<slice-id>"`); `FC` refuses slice ids and classes outside
`^[a-z0-9][a-z0-9-]{0,63}$`.

## One dispatch = four steps

1. **Write the brief** to `runtime/briefs/<slice>-<class>.txt`. Reviewer briefs (review,
   rereview, drain-review, calibrate) come from `FC brief` (below), never by hand: they pass the
   PATHS of the diff, the round-1 findings, the fixer report or `debt.md`, and the reviewer (it
   has Read) reads them in full. Implement and fixer briefs carry their content inline (Write
   tool). Never tell an agent to "read the brief/plan/review".
2. **Dispatch** with the Agent tool: `subagent_type: bajzi:<agent>`, `prompt` = the brief file's
   text verbatim, `description` = the row's description below (the dispatch guard classifies on it).
3. **Log** one line, whatever happened:
   `FC log <class> bajzi:<agent> runtime/briefs/<slice>-<class>.txt allow` (`deny` if the harness
   refused the dispatch). It appends `<ISO-UTC>\tSKILL-<CLASS>\t<agent>\t<chars>\t<allow|deny>`
   to `runtime/dispatch-sizes.log`; the `SKILL-` prefix keeps it apart from the hook's own line.
   **Denied** (the reason starts `dispatch-guard R<n>:`) -> print the reason with its rule id and
   STOP the skill. Never retry with a trimmed or reworded brief; the owner decides.
4. **Save the final message** verbatim where the row says (Write tool), before reading it.

| class | agent | description | brief = | final message saved to |
|---|---|---|---|---|
| implement | the `agent:` from `FC slice <id>` | `implement <slice>` | the slice file, verbatim | — (read DONE/BLOCKED) |
| review | reviewer | `review <slice> round 1` | `FC brief review <slice> 1 <base>..<tip>` | `runtime/findings/<slice>-r1.md` |
| rereview | reviewer | `re-review <slice> round 2` | `FC brief review <slice> 2 <base>..<tip>` | `runtime/findings/<slice>-r2.md` |
| fix | fixer | `fix round <slice>` | fixer brief below | `runtime/findings/<slice>-r1.report.md` |
| drain-fix | fixer | `fix round debt` | fixer brief on `debt.fixer.md` | `runtime/findings/debt.report.md` |
| drain-review | reviewer | `re-review debt round 2` | `FC brief review debt 2 <base>..<tip>` | `runtime/findings/debt-r2.md` |
| calibrate | reviewer | `calibrate debt` | `FC brief calibrate` | `runtime/findings/debt.rerate.txt` |

## Reviewer briefs (`FC brief`)

`FC brief review <slice> <1|2> <base>..<tip>` resolves both ends to full SHAs, writes the complete
`git diff` to `runtime/briefs/<slice>-r<round>.diff`, then writes the brief and prints its path.
The brief holds: the `slice_id/round/range` line (SHAs), the code-review-graph marker line (guard
R1), the diff path, in round 2 the round-1 file and fixer report paths (`debt.md` /
`debt.report.md` for slice `debt`), and the changed-file list. So it stays small whatever the
diff size; over 24000 chars it exits 2 (split the slice). Round 1 when `<slice>-r2.md` exists
exits 3 (STOP: the slice had its two rounds). `FC brief calibrate` writes
`runtime/briefs/debt-calibrate.txt`: `Calibration mode.`, the opt-out line
`GRAPH: n/a single-file runtime/findings/debt.blind.md` (`bajzi:reviewer` is classified REVIEW,
so R1 applies), and the file to re-rate.

## Fixer brief

```
slice_id: <slice>
fixer copy: <the path `FC copy fixer` printed: runtime/findings/<slice>-r1.fixer.md or debt.fixer.md>
files you may touch: <files: from the slice>
test command: <test: from the slice>
<the .fixer.md file, verbatim>
```
