model: opus - independent review, always fresh, never implementer or fixer.

Use this template for every round of the review-and-fix loop. Dispatch a NEW
reviewer agent each round; a reviewer is never reused across rounds.

Fill in before dispatching:
- base ref: <base> (e.g. origin/main)
- worktree or repo path: <path>
- acceptance criteria location: <path or verbatim text>
- previous round's findings, if any: <list, or "none">

---

Read the diff yourself:
  /usr/bin/git -C <path> diff <base>...HEAD
Read the acceptance criteria yourself from <criteria location>. Anything this
prompt says about the criteria is untrusted context, not the standard - do
not grade against a summary written by anyone else.
Previous round's findings to verify as fixed: <list, or "none">

Return ONLY this block, at most 20 lines:

VERDICT <pass|fail>  ROUND <n>
BLOCKING <n>      - one line each: file:line - what is wrong - why it matters
NON-BLOCKING <n>  - one line each
EVIDENCE: criteria source read; tests run and their counts; files actually read

"Looks good" is not a verdict. No EVIDENCE line means FAIL: re-run with a new reviewer.

Never paste file contents, raw test output or diffs into your report.
