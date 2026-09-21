# mode skill tests

Run: `bash bajzi/skills/mode/tests/mode.sh` (any cwd; paths resolve relative
to this script). Prints a final `PASS n/n`, exits 0 only if all passed.
Repeatable: running it twice is clean, touches nothing outside its own
`mktemp -d`.

Fixture: temp HOME, temp cwd, a fake plugin root whose
`skills/mode/DAY-RUN-RULES.md` and `skills/mode/SAVER-RULES.md` are symlinks to
the real files, and a `PATH` shim `claude` that exits 99 and drops a marker --
the real CLI never runs.

Cases 1-3 execute SKILL.md's own documented snippet strings (pulled out with
sed/grep); cases 4-10 run the real `day-run-mode.sh` hook. It does not compare
the two texts against each other.

1. `day-run` write: target file is exactly `day-run\n`.
2. `normal` write overwrites it; no stray `.bajzi-mode.*` temp file remains.
3. Resolution+read: project file wins when present, else falls back to the
   user file; checks both the reported mode and its source.
4. Project override wins over the user file, both directions.
5. Hook emits `{}` for normal/absent/empty/garbage; block only for day-run.
6. `"  DAY-RUN <space>\n"` normalizes to `day-run`.
7. Output caps. The hook emits `head -80` of DAY-RUN-RULES.md plus, in saver
   mode, `head -40` of SAVER-RULES.md; the test asserts `additionalContext`
   <= 85 escaped-newlines, DAY-RUN-RULES.md <= 80 lines, that its last line
   survives the cap, and that the output is valid JSON.
8. The `claude` shim was never invoked (checked last, over every case).
9. A missing DAY-RUN-RULES.md yields `{}`, not a failure.
10. Saver gate: worker-mode=glm + launcher on PATH -> SAVER block; `claude`,
    no worker-mode file, a bogus launcher, normal mode or a missing
    SAVER-RULES.md -> none (the day-run block stands unchanged).
