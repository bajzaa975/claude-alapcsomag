model: haiku - locate/map work only, paths and line numbers, no reasoning.

Use this template to dispatch a sub-agent that locates code or maps a layout.
If the haiku pass returns nothing useful, retry once with sonnet. Never do
this lookup in the main thread.

Fill in before dispatching:
- task: <what to find>
- scope: <directory or file glob to search>

---

Find <task> within <scope>.

Return ONLY:
- file paths and line numbers, nothing else
- at most 10 lines total
- no file contents, no surrounding code, no explanation

Never paste file contents, raw test output or diffs into your report.
