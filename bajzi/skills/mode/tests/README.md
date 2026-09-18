# mode skill tests

Run: `bash bajzi/skills/mode/tests/mode.sh` (any cwd; paths resolve relative
to this script). Prints a final `PASS n/n`, exits 0 only if all passed.
Repeatable: running it twice is clean, touches nothing outside its own
`mktemp -d`.

Fixture: temp HOME, temp cwd, a fake plugin root whose
`skills/mode/DAY-RUN-RULES.md` is a symlink to the real file, and a `PATH`
shim `claude` that exits 99 and drops a marker -- the real CLI never runs.

Cases 1-3 pull the write sequence and read command verbatim out of SKILL.md
with sed/grep and execute those exact strings, so drift from the hook fails
the test. Cases 4-9 run the real `day-run-mode.sh` hook.

1. `day-run` write: target file is exactly `day-run\n`.
2. `normal` write overwrites it; no stray `.bajzi-mode.*` temp file remains.
3. Resolution+read: project file wins when present, else falls back to the
   user file; checks both the reported mode and its source.
4. Project override wins over the user file, both directions.
5. Hook emits `{}` for normal/absent/empty/garbage; block only for day-run.
6. `"  DAY-RUN <space>\n"` normalizes to `day-run`.
7. `additionalContext` <= 45 escaped-newlines; DAY-RUN-RULES.md <= 40 lines.
8. The `claude` shim was never invoked (checked last, over every case).
9. A missing DAY-RUN-RULES.md yields `{}`, not a failure.
