model: sonnet - implementing a specified slice with TDD, risk-bearing slices included (bajzi:implementer-risk, effort high: a failing test per changed branch). Opus only reviews. File count alone is not risk.

Use this template to dispatch the implementer for one slice.

Brief must carry, verbatim, never paraphrased:
- owned files: <list> (disjoint from every other slice in flight)
- acceptance criteria: <verbatim from the source doc>
- test command: <exact command to run>

---

Implement <slice description> in <owned files> only. Write the failing test
first, then make it pass.

Meet exactly the acceptance criteria above - do not narrow, widen or
reinterpret them. Run: <test command>

Return, at most 15 lines:
- files changed
- test counts (pass/fail)

Never paste file contents, raw test output or diffs into your report.
Time matters here: do not spend time that can be avoided, and the earlier a correct result is obtained, the better.
