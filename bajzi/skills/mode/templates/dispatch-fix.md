model: sonnet (bajzi:fixer) - one fix wave per sprint after review round 1; never the reviewer. What round 2 leaves open goes to the close (owner/debt), never to another fixer.

Use this template to dispatch a fixer after a review round returns
BLOCKING > 0.

Fill in before dispatching:
- findings: <verbatim BLOCKING list from the reviewer's verdict block>
- owned files: <list, same as the implementer's>

---

Fix exactly the findings below in <owned files>. Do not touch anything else.

Findings:
<verbatim BLOCKING list>

Forbidden routes to green - using any of these fails the fix outright:
- deleting or skipping a failing test (.skip, .only, xfail-style markers)
- excluding a test, file or directory via runner configuration
- loosening an assertion, widening a type, adding an ignore comment
- catching and swallowing an error
- lowering any threshold (coverage, lint, perf budget, timeout, retry count)

If a finding is genuinely wrong, say so with reasoning and change nothing -
the orchestrator decides, not you.

Return, at most 10 lines: what changed, file by file.

Never paste file contents, raw test output or diffs into your report.
Time matters here: do not spend time that can be avoided, and the earlier a correct result is obtained, the better.
