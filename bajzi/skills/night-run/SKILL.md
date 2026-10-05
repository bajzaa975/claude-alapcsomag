---
name: night-run
description: Plan an unattended multi-hour overnight autopilot run for one project — preflight, queue, rendered brief, approval gate, and the copy-pasteable launch block the owner runs at bedtime. Use it when the user says "night run", "/bajzi:night-run", "overnight autopilot", "plan tonight's run", "run the backlog overnight", "éjszakai futás", "night run terv".
---

# Night run — you plan it, the owner launches it

The full design is in `docs/superpowers/specs/2026-09-18-night-run-design.md` of this
plugin repo. READ IT when a detail here is not enough: this file is the procedure, the spec
is the reasoning, and where they disagree the spec wins. You never start the runner (PHASE
E) and you never edit `run.sh` or the templates per project — everything project-specific
goes into generated files under `~/night-runs/<project>/`.

## Arguments

    project:<name>   REQUIRED. A project the Brain knows. Verify with `brain next <name>`;
                     if it does not resolve, STOP and list the projects the Brain does know.
    model:opus       Orchestrator model = entry [0] of the reviewer allow-list; omitted =
                     the same. Read it with
                     `node "${CLAUDE_PLUGIN_ROOT}/hooks/node/lib/reviewer-models.js" --first`
                     (`reviewer_models` in `~/.claude/bajzi/config.json`); exit 1 = the list
                     is invalid, a BLOCKER at the PHASE D gate ("run /bajzi:setup"), never a
                     guessed id. It sets ONLY the per-story orchestrator — the review-and-fix
                     loop's reviewer is ALWAYS a model on that allow-list.
    hours:<n>        Queue budget in hours, default 8. It SIZES the queue, and PHASE E's
                     `--deadline` — the hard stop — is DERIVED from it: launch time plus
                     `hours:`, capped at 07:30. They are one number, never two.
    status           Bare mode: read-only health check (below). Changes nothing.
    report           Bare mode: PHASE F, the morning follow-through (spec section 5).

## Review loop — when an item is actually done

Every queue item goes through the review-and-fix loop, and the reviewer is **always the reviewer
allow-list's first entry** (`{{REVIEWER_MODEL}}` in the brief) —
whatever the per-story orchestrator is, and whatever model wrote the code. The reviewer model is
not a variable, and it never drops a tier because a diff looks small.

The loop does not stop after one pass. Findings go to a FIXER sub-agent — never the reviewer that
raised them — and the fix gets a NEW reviewer round. Fix → review → fix → review, until it
comes back clean. A single fix wave is not a loop.

**Clean** means zero Critical AND zero Important findings AND the repo's own gate green. Minor and
cosmetic findings are collected into the morning report for the owner, never looped on — style nits
regenerate forever and would burn the night without making anything safer.

Nothing is reported DONE, and nothing is merged, before that loop terminates clean. "The tests
pass" is not done. "The implementer says it works" is not done. A clean review round plus a green
gate is done; anything short of it is PARKED, with its open findings named.

Watch for tests that pass for the wrong reason. A test asserting only that *something* was refused
stays green after the check it exists to guard is deleted, because the code has several refusal
paths. A reviewer that cannot say WHICH path refused has not verified that test.

## PHASE A — Preflight

Run all of it before planning anything, and run step 0 FIRST — steps 3, 4, 5 and 8, and the
whole of PHASE C, read values out of `config.env`, so it has to exist and be checked before
anything reads it. Exactly two findings STOP the skill on the spot, because nothing past
them is worth planning: a live runner FOR THIS PROJECT (steps 1-2) and a missing
`docs/NIGHT-RULES.md` (step 6). Every other failure is a BLOCKER — carry it and report it at
the PHASE D gate, do not stop.

**`<REPO>` and `<BASE>` are TWO DIFFERENT THINGS and this skill decides both.** `REPO` is
`owner/name` — a GitHub coordinate, the argument `gh` takes after `-R`; `run.sh` refuses at
startup anything without a `/` in it. `BASE` is an absolute FILESYSTEM PATH, the repo
checkout directory the run works from: `run.sh` tests `[ -d "$BASE" ]`, requires
`$BASE/.claude/settings.local.json`, and runs `df` on it. **Never pass `REPO` to `-C`, to
`df`, or as the first half of a path** — `git -C bajzaa975/innotel-bss fetch` dies with
`fatal: cannot change to …: No such file or directory`, and `<REPO>/docs/NIGHT-RULES.md`
opens nothing. Anywhere below that a path is meant, it is spelled `<BASE>`; `<REPO>` appears
only where the `owner/name` value is wanted. There is no third spelling.

0. **`config.env` — resolve and validate it BEFORE anything reads it.** It is the single
   source of `REPO`, `BASE`, `BASE_BRANCH`, `NIGHT_DIR`, `DISK_FLOOR_GB` and the thirteen
   PHASE C placeholders, and `BASE` in particular is the directory the allowlist is
   installed into and every story session starts from — an invented value points the whole
   night at the wrong tree.

   ```bash
   CFG=~/night-runs/<project>/config.env
   [ -f "$CFG" ] && echo "CONFIG PRESENT" || echo "FIRST RUN — no config.env yet"
   ```

   **`CONFIG PRESENT`** → load it and check it before anything uses it:

   ```bash
   set -a; . "$CFG"; set +a
   case "$REPO" in */*) :;; *) echo "BLOCKER: REPO is not owner/name: '$REPO'";; esac
   [ -d "$BASE" ]      || echo "BLOCKER: BASE is not a directory: '$BASE'"
   [ -d "$NIGHT_DIR" ] || echo "BLOCKER: NIGHT_DIR is not a directory: '$NIGHT_DIR'"
   case "$DISK_FLOOR_GB" in ''|*[!0-9]*) echo "BLOCKER: DISK_FLOOR_GB is not a number";; esac
   ```

   Any line of output is a gate BLOCKER — carry it, and never substitute a guess for the
   bad field. `REPO` and `BASE` are the two that must not be confused; see the paragraph
   above.

   Seven more keys are OPTIONAL — absent is fine, every one has a default, and an older
   `config.env` still starts (`templates/config.env.tmpl` carries the same list, commented
   out):

   - `WATCH_INTERVAL` (900) — seconds between watchdog ticks; `0` turns the watchdog off.
   - `WATCH_MAX_RESTARTS` (2) — how many times the watchdog may restart a dead runner.
   - `WATCH_NOTIFY_CMD` (none) — a command called with ONE argument, the message.
   - `QUOTA_MARGIN_SEC` (180) — seconds added to the announced usage-limit reset before a
     session is launched again; `run.sh` applies it once, when it writes `quota-until`.
   - `QUOTA_MAX_WAITS` (3) — how many usage-limit waits ONE run may take before it finishes.
   - `QUOTA_MAX_WAIT_SEC` (21600) — the longest SINGLE usage-limit wait; beyond it the run
     leaves the rows `DEFERRED-quota`, reports and finishes instead of holding the run lock.
   - `QUOTA_FALLBACK_WAIT_SEC` (1800) — the wait used when the reset time cannot be parsed.

   **`FIRST RUN`** → create it here, before step 3, and never later:

   ```bash
   mkdir -p ~/night-runs/<project>/logs
   cp <absolute path of templates/config.env.tmpl> ~/night-runs/<project>/config.env
   ```

   Then fill in every `<...>` with a value you RESOLVED, and say where each came from:
   `REPO` and `BASE_BRANCH` from `gh repo view --json nameWithOwner,defaultBranchRef`;
   `NIGHT_DIR` from the template's own convention; `BASE` from the existing checkout of
   `REPO` on this machine — find it, do not guess it:
   `/usr/bin/git -C "<candidate>" remote get-url origin` must name `REPO`. If NO checkout
   resolves, or MORE THAN ONE does, `BASE` is the one value you may not settle yourself:
   leave it unfilled, carry it as the first line of the PHASE D gate, and plan nothing that
   depends on it. A freshly written `config.env` is a gate item in its own right — show the
   owner the whole file at PHASE D, because everything below was derived from it.

1. **Is a runner already alive FOR THIS PROJECT?** Identify a runner by its ARGV, never by a
   `pgrep` pattern. The spec names `pgrep -af "bash .*/run\.sh( |$)"` as one of three WRONG
   forms: it also matches the shell running the check and the `pgrep` subshell — five pgids
   for one live runner, observed 2026-09-18. A process IS a runner when `argv[1]` (or
   `argv[0]`, when run.sh is executed directly) basenames to `run.sh`; a shell that merely
   mentions run.sh has `argv[1] == "-c"` and is excluded. Scope it to THIS project by
   requiring this project's config path in the same argv — another project's runner must
   never block this project's plan. `is_runner_pid` in `run.sh` is the same ARGV test, but
   only that half: `run.sh`'s `live_runner_pgids` applies NO config scoping, so its own fence
   counts EVERY `run.sh` on the machine. The two answer different questions — never read one
   as a proxy for the other.

   ```bash
   CFG=~/night-runs/<project>/config.env           # THIS project's config, absolute
   pids=$(pgrep -f 'run\.sh'); rc=$?   # NEVER `for p in $(pgrep ...)`: that throws the rc away
   [ "$rc" -le 1 ] || { echo "RUNNER SCAN FAILED (pgrep rc=$rc)"; exit 1; }   # 0=hits 1=none >1=broken
   for p in $pids; do
     [ -r "/proc/$p/cmdline" ] || continue
     argv=$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null) || continue
     a0=$(printf '%s\n' "$argv" | sed -n 1p); a1=$(printf '%s\n' "$argv" | sed -n 2p)
     [ "${a1##*/}" = run.sh ] || [ "${a0##*/}" = run.sh ] || continue
     printf '%s\n' "$argv" | /usr/bin/grep -qxF "$CFG" || continue
     awk '{print $5}' "/proc/$p/stat" 2>/dev/null   # field 5 of stat = pgid
   done | sort -u
   ```

   `RUNNER SCAN FAILED`: the SCAN broke (pgrep missing, denied, rewritten), so the empty
   result means nothing — refuse and report it as a STOP, never read it as "no runner". This
   is `run.sh`'s own rule at `live_runner_pgids`, whose comment records that reading an
   erroring pgrep as "nobody home" has started a second runner in one worktree three times.

   **This test is deliberately narrow and it has a known blind spot — step 2 is what covers
   it, so step 2 is NOT optional.** `grep -qxF "$CFG"` demands the config path as its own
   argv word, which only a `--config <path>` launch produces. `run.sh:91` also accepts
   `CONFIG=${NIGHT_CONFIG:-}`, and `config.env.tmpl` advertises that form: a runner started
   as `NIGHT_CONFIG=… bash ./run.sh` carries NO config path in argv at all and is invisible
   here. PROVEN on this machine 2026-09-18 — the live runner's whole argv was `bash ./run.sh`
   and nothing else. So "no line" means *no runner NAMED this config*, never "no runner";
   only step 2's `run.flock` cross-check can tell those apart, and it must always be run.

   No line, rc 0 or 1: continue TO STEP 2. ONE line: a live run for this project — STOP. TWO OR MORE:
   STOP and report it loudly, that is two runners sharing one worktree. Never a bare `ps | grep`:
   `rtk` rewrites `ps`, the format changes, the pattern silently finds nothing, and on
   2026-09-18 that made a healthy runner look dead.
2. **Cross-check the lock — always, whatever step 1 printed.** `run.flock` is THE lock: the
   runner holds `flock(2)` on it for the whole run, the kernel releases it the instant the
   runner dies, and the file is never unlinked — so there is no such thing as a stale
   `run.flock` and there is never anything to clean up. `run.lock` is a REPORT, not a lock:
   one line carrying the live runner's pgid, for humans and for this check. Ask the kernel,
   never the file:

   ```bash
   ND=~/night-runs/<project>
   exec 9>>"$ND/run.flock"
   if flock -n 9; then flock -u 9; echo "NO RUNNER"; else echo "RUNNER ALIVE (run.lock says pgid $(cat "$ND/run.lock" 2>/dev/null || echo '-'))"; fi
   exec 9>&-
   ```

   **`NO RUNNER`** — nobody holds the lock: continue, and carry NOTHING to the gate. A
   `run.lock` left behind next to a free `run.flock` is stale bookkeeping, not a blocker;
   never delete it yourself. **`RUNNER ALIVE`** — a run for this project is live: STOP. This
   is also exactly the case step 1 cannot see on its own when the runner was started as
   `NIGHT_CONFIG=… bash ./run.sh`.
3. **Git.** Quote the path exactly as written — the allowlist's scoped `-C` rules match the
   raw command text, and a bare or differently quoted path falls through to the classifier:

   ```bash
   /usr/bin/git -C "<BASE>" fetch origin --prune
   ```

   There is no "local `<BASE_BRANCH>` is behind its remote" check: BASE is moved onto a
   `night/base-*` branch cut from `origin/<BASE_BRANCH>` below and the local `<BASE_BRANCH>`
   is never advanced, so that count would only grow. What keeps the render honest is the
   `render-base.sha` / `ls-remote` check at PHASE D.

   **Fresh BASE — nothing is rendered from a stale tree.** `BASE` is a long-lived checkout
   that still holds whatever an earlier night left on it, and `docs/NIGHT-RULES.md`, the
   section-3 and section-7 rulings and every other value read from BASE's files come from
   THAT tree. So, in THIS phase (an earlier fetch, from another session or an earlier phase,
   does not count), fetch the base branch again and move BASE onto a NEW branch cut from it:

   ```bash
   /usr/bin/git -C "<BASE>" fetch origin <BASE_BRANCH>
   /usr/bin/git -C "<BASE>" status --porcelain --untracked-files=no
   ```

   Any line from `status` means BASE's tracked tree is dirty: BLOCKER `BASE tracked tree is
   dirty: <the lines>`, carried to the gate. Do NOT move BASE, do NOT stash, reset or clean
   it, and plan nothing that reads BASE's files. A clean tree continues (steps 1-2 already
   proved no runner of this project is alive, so nothing is working in it):

   ```bash
   STAMP=$(date +%Y-%m-%d-%H%M)
   /usr/bin/git -C "<BASE>" checkout --no-track -b "night/base-$STAMP" "origin/<BASE_BRANCH>" || echo "BLOCKER: checkout failed"
   # earlier night/base-* branches are no longer checked out now: delete them, same step
   /usr/bin/git -C "<BASE>" for-each-ref --format='%(refname:short)' 'refs/heads/night/base-*' | while read -r b; do [ "$b" = "night/base-$STAMP" ] || /usr/bin/git -C "<BASE>" branch -D "$b"; done
   /usr/bin/git -C "<BASE>" rev-parse "origin/<BASE_BRANCH>" > "<NIGHT_DIR>/render-base.sha"
   cat "<NIGHT_DIR>/render-base.sha"
   ```

   A failing `checkout` is a BLOCKER too (same rule: plan nothing from BASE). The SHA in
   `render-base.sha` is the `origin/<BASE_BRANCH>` the render uses; PHASE D prints it. This
   branch is the ONLY thing this skill ever switches BASE to; `<BASE_BRANCH>` itself is never
   checked out, committed to or pushed. Steps 6-8 and the whole of PHASE C read BASE's files
   only after this point. (The BASE rules above are unchanged: `BASE` comes from `config.env`
   and is never a deployed tree or a `REPO` coordinate.)
4. **Disk.** `df -BG --output=avail "<BASE>" | tail -1` must be at or above `DISK_FLOOR_GB`
   from `config.env` — the build cache has filled this VM's root twice.
5. **Is the base branch red?** The latest `REQUIRED_CHECK` run on the base branch:
   `gh run list -R <REPO> --branch <BASE_BRANCH> --limit 3 --json name,conclusion,event`.
   Red = the top blocker; do not queue filler work around a red base.

   **Is `REQUIRED_CHECK` the name the night matches?** The night compares `REQUIRED_CHECK`
   with the NAME OF THE WORKFLOW RUN as `gh run list` shows it (the workflow file's `name:`,
   e.g. `CI`), read from a `pull_request`-event run (`run.sh` puts the value into the per-story
   prompt and BRIEF section 5.1 reads runs with `gh run list ... --json ...`; neither ever
   looks at branch protection). The branch-protection check or job name (e.g. `ci`) is a
   different string and does NOT match. Look at what `gh` prints for this repo:

   ```bash
   gh run list -R "<REPO>" --event pull_request --limit 10 --json workflowName,name --jq '.[].workflowName' | sort -u
   ```

   The configured value must appear in that output as a whole line:

   ```bash
   set -a; . ~/night-runs/<project>/config.env; set +a
   gh run list -R "<REPO>" --event pull_request --limit 10 --json workflowName,name --jq '.[].workflowName' | /usr/bin/grep -qxF -- "$REQUIRED_CHECK" \
     || echo "BLOCKER: REQUIRED_CHECK '$REQUIRED_CHECK' is not a workflow run name; gh shows: $(gh run list -R "<REPO>" --event pull_request --limit 10 --json workflowName --jq '.[].workflowName' | sort -u | tr '\n' ',')"
   ```

   A line of output is a gate BLOCKER carrying the value(s) found; never "fix" the config
   value yourself from a guess. (`gh run list -R <REPO> --limit 3 --json workflowName,name`
   is the plain form of the command, as documented in `config.env.tmpl` and NIGHT-RULES
   section 5.) A repo with no `pull_request` run yet cannot prove the name: carry that as a
   BLOCKER too, naming the value you could not verify.
6. **`docs/NIGHT-RULES.md` gate.** Missing in the project repo → copy
   `templates/NIGHT-RULES.md.tmpl` there, show the owner that it needs their rulings, STOP.
7. **User-level env denies.** Every new env var a story adds must reach the tracked
   `.env.example`, so a user-level deny that covers it breaks the night. Check
   `~/.claude/settings.json` and `~/.claude/settings.local.json` `permissions.deny` for a
   `Read(...)`/`Edit(...)` rule whose glob also matches `.env.example`: it ends in `.env*`,
   `.env.*` or `.env.**` (with or without a `**/` prefix),
   and for any rule using a bracket class on an env name (`.env.[!e]*`, `.env.[^e]*`):
   measured 2026-10-03 on Claude Code 2.1.288, the real matcher does NOT read `[!e]` as
   negation, so `Read(.env.[!e]*)` ALLOWS `.env.local` and DENIES `.env.example` (the
   `_comment_env` key of `templates/settings.local.json.tmpl`). Write the script below to
   `<NIGHT_DIR>/user-deny-check.js` with the Write tool (a Bash command whose text names an env
   file is refused by bajzi's secret guard), then run `node "<NIGHT_DIR>/user-deny-check.js"`:

   ```js
   // user-deny-check.js - PHASE A step 7. Reads ~/.claude/settings.json and settings.local.json only.
   const fs = require('fs'), os = require('os'), path = require('path');
   // The explicit env-name list of templates/settings.local.json.tmpl and setup/manifest.json.
   const NAMES = ['.env', '.env.local', '.env.*.local', '.env.production*', '.env.development*', '.env.test*', '.env.staging*'];
   for (const f of ['settings.json', 'settings.local.json']) {
     const p = path.join(os.homedir(), '.claude', f);
     let raw;
     try { raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { continue; }   // missing: nothing to check
     let rules;
     try { rules = ((JSON.parse(raw) || {}).permissions || {}).deny; }
     catch (e) { console.log(`USER SETTINGS NOT PARSED: ${p}: ${e.message}`); continue; }
     for (const rule of Array.isArray(rules) ? rules : []) {
       const m = /^(\w+)\((.*)\)$/.exec(String(rule));
       if (!m) continue;
       const [, kind, glob] = m;
       const list = NAMES.map((n) => `${kind}(${glob.slice(0, glob.lastIndexOf('.env'))}${n})`).join(', ');
       if (/^(Read|Edit)$/.test(kind) && /(^|\/)\.env\.?\*+$/.test(glob)) console.log(`USER DENY BLOCKS .env.example: ${rule} -> replace it with ${list}`);
       else if (/\.env[^/]*\[/.test(glob)) console.log(`USER DENY INVERTED: ${rule} -> replace it with ${list}`);
     }
   }
   ```

   Every `USER DENY BLOCKS .env.example: <rule> -> replace it with <explicit list>` and every
   `USER DENY INVERTED: <rule> -> replace it with <explicit list>` line is a BLOCKER, carried
   verbatim: `<explicit list>` is the explicit env-name list, same Read/Edit kind and same
   prefix as the hit. `USER SETTINGS NOT PARSED: <file>: <error>` is reported at the gate, not
   fatal; the other file is still checked. Never recommend a bracket class. Never edit the
   user's settings yourself; the owner does.
8. **Saver level: GLM preflight, only at L1-L3.** Resolve the level with the resolver the bajzi
   hooks share (`CC_WORKER_MODE`, else `~/.claude/worker-mode`, forced to `tight` on a
   non-Anthropic `ANTHROPIC_BASE_URL`):

   ```bash
   . "${CLAUDE_PLUGIN_ROOT}/hooks/lib-saver-level.sh"; saver_resolve "<BASE>"
   case "$SAVER_LEVEL" in light|glm|tight) echo "SAVER $SAVER_LEVEL: run step 8" ;; *) echo "SAVER L0 ($SAVER_LEVEL): skip step 8" ;; esac
   ```

   At L0 nothing in this step runs (an unknown word counts as L0, as in `day-run-mode.sh`). At
   L1-L3 (`light`/`glm`/`tight`) the night dispatches work to `glm`, so prove it can work:

   **(a) Launchers.** Any line is a BLOCKER with the fix
   `bash "${CLAUDE_PLUGIN_ROOT}/bin/install.sh"` (print it with the plugin root resolved);
   (b) and (c) wait until it is fixed.

   ```bash
   for c in glm worker; do command -v "$c" >/dev/null || echo "BLOCKER: $c not on PATH"; done
   ```

   **(b) Z.ai key.**

   ```bash
   worker --status | grep -Eq '^ZAI_API_KEY[[:space:]]+found' && echo "ZAI KEY FOUND" || echo "ZAI KEY MISSING"
   ```

   `ZAI KEY MISSING`: render `templates/set-zai-key.sh.tmpl` to `<NIGHT_DIR>/set-zai-key.sh`
   (`{{NIGHT_DIR}}` = the absolute `NIGHT_DIR`, nothing else) and carry a BLOCKER with the
   owner's exact command, `bash <NIGHT_DIR>/set-zai-key.sh`, typed in a plain bash terminal on
   the night machine (it prompts for the key, so not the Claude Code prompt). It takes
   `read-secret.sh` from the newest bajzi-infra copy in the plugin cache, else
   `<NIGHT_DIR>/read-secret.sh`; atomically replaces only the `ZAI_API_KEY` line of
   `~/.claude/cc-router.env` (mode 600), keeping every other line; prints the level
   and key lines of `worker --status`; never changes the saver level; a re-run replaces the
   key. Never ask for the key in chat. (c) waits until the owner reports it done.

   **(c) GLM smoke, exactly as the night dispatches GLM.** GLM is ~10x slower than Sonnet, so
   the smoke takes minutes. `<date>` is today, `YYYY-MM-DD`. Set up a throwaway worktree from
   the freshly fetched base (a leftover from an earlier smoke is removed first, registered or
   not, with or without its directory):

   ```bash
   /usr/bin/git -C "<BASE>" fetch origin --prune
   /usr/bin/git -C "<BASE>" worktree remove --force "<NIGHT_DIR>/wt/SMOKE-GLM" 2>/dev/null
   rm -rf "<NIGHT_DIR>/wt/SMOKE-GLM"
   /usr/bin/git -C "<BASE>" worktree prune
   /usr/bin/git -C "<BASE>" branch -D night/smoke-glm-<date> 2>/dev/null
   /usr/bin/git -C "<BASE>" worktree add -b night/smoke-glm-<date> "<NIGHT_DIR>/wt/SMOKE-GLM" origin/<BASE_BRANCH>
   mkdir -p "<NIGHT_DIR>/logs"
   ```

   With the Write tool (the secret guard refuses a Bash command naming the file), create
   `<NIGHT_DIR>/wt/SMOKE-GLM/.env` holding exactly `SMOKE_DUMMY=1`: a dummy, no secret, so the
   prompt's read probes a real file. A refused Write is a BLOCKER naming that file. Render
   `templates/GLM-SMOKE-PROMPT.md.tmpl` to `<NIGHT_DIR>/GLM-SMOKE-PROMPT.md` (Write tool):
   `{{WORKTREE}}` = `<NIGHT_DIR>/wt/SMOKE-GLM`; `{{INSTALL_CMD}}`, `{{TYPECHECK_CMD}}`,
   `{{TEST_CMD}}` = the repo's commands from NIGHT-RULES section 5 (CI facts) or 6, else from
   the workflow that runs `REQUIRED_CHECK`, naming the source of each (no typecheck in CI =
   `echo "no typecheck in CI"`; an install or test command you cannot resolve is a BLOCKER and
   the smoke does not run); `{{DOCKER_STEP}}` = ``8. Run `docker ps` and report whether it
   listed containers.`` only when NIGHT-RULES section 7 says `docker: allowed, container prefix
   <prefix>`, else an empty line (the step is omitted). No `{{` may be left.

   Run it with cwd = the worktree and NO permission flags: the GLM child gets the owner's
   default mode, not the night allowlist, and the smoke is what proves it can work there. It
   may take up to 25 minutes, longer than a foreground Bash call may run: start it in the Bash
   tool's background mode, wait for its exit, and stop it only by the PID you started.

   ```bash
   cd "<NIGHT_DIR>/wt/SMOKE-GLM" && timeout 1500 glm -p "$(cat "<NIGHT_DIR>/GLM-SMOKE-PROMPT.md")" --output-format json > "<NIGHT_DIR>/logs/glm-smoke.json" 2> "<NIGHT_DIR>/logs/glm-smoke.err"; echo "exit=$?"
   node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result || "")' "<NIGHT_DIR>/logs/glm-smoke.json"
   ```

   **Pass** = exit 0 AND a `STEP <n>: OK` line for every step 1-6 (and 8 when the docker step
   was rendered) AND `STEP 7: DENIED` AND `SMOKE_DUMMY` nowhere in the reply (it only appears
   when the read succeeded). Anything else is a BLOCKER `GLM SMOKE FAILED: <every STEP line
   that is not OK, verbatim>`: a missing STEP line counts as not OK, and `STEP 7: READ` or a
   `SMOKE_DUMMY` sighting means the GLM child can read secrets. A non-zero exit is a BLOCKER
   `GLM SMOKE FAILED: exit=<n>` plus the last lines of `glm-smoke.err`: exit 75 = the Z.ai
   peak-window refusal (re-run outside 06:00-10:00 UTC = 14:00-18:00 UTC+8; `glm-smoke.err`
   prints the local window), 78 = no API key (back to (b)), 124 =
   the 25-minute timeout.

   **Cleanup, pass or fail.** The smoke commit is throwaway: never push the branch.
   `--force` because the dummy env file and install output leave the worktree dirty, `-D`
   because the commit is unmerged:

   ```bash
   /usr/bin/git -C "<BASE>" worktree remove --force "<NIGHT_DIR>/wt/SMOKE-GLM"
   /usr/bin/git -C "<BASE>" branch -D night/smoke-glm-<date>
   ```

### `status` mode

The read-only subset of PHASE A: safe while a run is live, creates nothing, launches
nothing. Print and stop — runner alive plus its pgid (step 1); the current story and how
long it has run (`tail ~/night-runs/<project>/logs/runner.log`); this run's
`~/night-runs/<project>/state-<date>.txt` rows so far (`state.txt` is a symlink to that
file, so the old name still works) — an id may have more than one row, and its LAST row is
its outcome; `gh pr list --state open`; free disk.

## PHASE B — Collect

Sources, in precedence order:

1. `brain next <project> --sessions 5` — the primary well: id, branch, title, status, last touched.
2. `docs/BACKLOG.md` — size S/M/L, coding %, testing state, `depends-on`. Sizing and
   dependency data only; it adds no item the Brain does not know.
3. `gh pr list --state open` — PRs left open by earlier runs, as FOLLOW-UP items, never new stories.
4. The previous `~/night-runs/<project>/REPORT-<date>.md` — its PARKED and BLOCKED entries,
   each with the reason that parked it, as retry candidates.

Then SUBTRACT everything `docs/NIGHT-RULES.md` forbids: forbidden story ids, anything
touching a forbidden path, anything the migration policy reserves for daylight.
**TODO/FIXME mining and lint debt are NOT a source** — they map to no milestone and burn a
story slot a real backlog item needed. Do not scan for them.

## PHASE C — Plan

- **Dependency order.** Respect `depends-on`; a story whose dependency is unmerged is
  skipped FORWARD, never reordered upwards.
- **File-disjoint neighbours**, so consecutive stories do not fight over the same files.
- **Budget.** `S = 1 h · M = 2 h · L = 3 h · unsized = M` — observed session cost, not ideal
  effort. Queue until `hours:` is spent; `PER_STORY_TIMEOUT` stays the hard per-story cap.
- **Deferred items are listed WITH their reason** (budget, dependency, forbidden by the
  rules). Never drop an item silently.

PHASE A step 0 already created the run directory and `config.env`; re-assert the directory
here (`mkdir -p` is idempotent) so this phase still works when step 0's output is out of
sight. NOTHING ELSE creates it. `config.env` says `NIGHT_DIR` "must
already exist", and `launch.sh` (PHASE E) opens `logs/console.log` for the runner's output
in the OWNER'S shell, so `logs/` should be there before it runs (`launch.sh` also runs
`mkdir -p`, belt and braces):

```bash
mkdir -p ~/night-runs/<project>/logs
```

Everything below that reads a file of BASE (`docs/NIGHT-RULES.md` for `{{NIGHT_RULES}}`, the
section-3 and section-7 rulings, the rules check) reads the `night/base-<stamp>` branch PHASE A
step 3 created from a fresh `origin/<BASE_BRANCH>`, never the tree BASE happened to hold. If
that step did not run or was a BLOCKER, render nothing from BASE.

Then write into `~/night-runs/<project>/`:

- `launch.sh`, rendered from `templates/launch.sh.tmpl` into `<NIGHT_DIR>/launch.sh` on EVERY
  plan, overwriting an old one: a launch.sh left over from an earlier night points at that
  night's `run.sh` (the innotel-bss one pointed at an old `bajzi/1.13.0` plugin-cache path).
  Substitute with literal `str.replace`, like `BRIEF.md`: `{{PROJECT}}`, `{{BASE}}`,
  `{{NIGHT_DIR}}` from `config.env` (absolute); `{{DEADLINE}}` = the PHASE E `--deadline`
  value; `{{RUN_SH}}` = the absolute path of the `run.sh` in the plugin copy that is running
  THIS skill, resolved AT EVERY RENDER, never typed from memory, never copied from an earlier
  launch.sh and never the path of another plugin version:

  ```bash
  RUN_SH="${CLAUDE_PLUGIN_ROOT%/}/skills/night-run/run.sh"
  case "$RUN_SH" in /*) :;; *) echo "BLOCKER: RUN_SH is not absolute: '$RUN_SH'";; esac
  [ -f "$RUN_SH" ] || echo "BLOCKER: run.sh not found: $RUN_SH"
  python3 - "${CLAUDE_PLUGIN_ROOT%/}/skills/night-run/templates/launch.sh.tmpl" "<NIGHT_DIR>/launch.sh" \
    "$RUN_SH" "<PROJECT>" "<BASE>" "<NIGHT_DIR>" "<DEADLINE>" <<'PY'
  import sys
  tmpl, out, run_sh, project, base, night, deadline = sys.argv[1:8]
  src = open(tmpl).read()
  for k, v in (('RUN_SH', run_sh), ('PROJECT', project), ('BASE', base), ('NIGHT_DIR', night), ('DEADLINE', deadline)):
      src = src.replace('{{%s}}' % k, v)   # str.replace: both sides literal
  open(out, 'w', newline='\n').write(src)
  PY
  ```

  Check it, and refuse a launch.sh that fails any line (every line is a PHASE D gate item,
  and the same check runs again at the gate):

  ```bash
  L="<NIGHT_DIR>/launch.sh"; RUN_SH="${CLAUDE_PLUGIN_ROOT%/}/skills/night-run/run.sh"
  got=$(sed -n 's/^setsid nohup bash "\(.*\)" --config .*/\1/p' "$L")
  [ -n "$got" ] || echo "LAUNCH.SH NOT RENDERED: no runner line in $L"
  [ -f "$got" ] || echo "LAUNCH.SH RUN_SH MISSING: $got"
  [ "$got" = "$RUN_SH" ] || echo "LAUNCH.SH RUN_SH STALE: $got is not the current plugin's $RUN_SH"
  /usr/bin/grep -o '{{[A-Za-z_0-9]\+}}' "$L" | sort -u
  bash -n "$L" || echo "LAUNCH.SH SYNTAX ERROR"
  ```

  A launch.sh whose RUN_SH does not exist, or differs from the current plugin root, is
  re-rendered, never edited by hand and never handed to the owner.
- `queue.txt`, one line per story in exactly the format the runner parses (`#` starts a
  comment): `<id>|<slug>|<needs>|<note>`.
  `<slug>`: lowercase, hyphenated, <= 5 words (it becomes `feat/<BRANCH_PREFIX>-<id>-<slug>`).
  `<needs>`: `-` for none, otherwise the NUMBER of a PR that must be MERGED first.
  `<note>`: the acceptance criteria, one line — the reviewer is given this verbatim, so it
  may NEVER be empty and never `-` (that is the needs column's "none" value, not this
  one's; run.sh rejects such a line at parse time as `BLOCKED-criteria` and the story never
  runs). Pipes inside the note are fine here — `IFS='|' read -r id slug needs note` lets the
  note absorb every remaining pipe intact; they are a problem only in the table below.
  **Name mapping, deliberate, do not "correct" either side:** the 4th FIELD of `queue.txt` is
  called `<note>` because that is the name `run.sh` parses it under
  (`IFS='|' read -r id slug needs note`, and its block message calls it "the 4th column"), but
  in the rendered `{{QUEUE_TABLE}}` that same field is the column headed **`criteria`** —
  which is the header the brief's eight "acceptance-criteria cell" / "criteria column"
  references resolve against. `queue.txt` keeps `note`; the markdown header says `criteria`.
- `WATCHER-BRIEF.md`, rendered from `templates/WATCHER-BRIEF.md.tmpl` into the night dir: substitute
  `{{PROJECT}}` (config), `{{RUNNER}}` = `run.sh`, `{{RUN_DIR}}` = the night dir, `{{RUN_LOG}}` =
  `<night dir>/logs/runner.log`, `{{TERMINAL_LINE_REGEX}}` = `^\S+ (merged|open|parked|blocked|DEFERRED-\S+) `,
  `{{PROMPT_TEMPLATE}}` = `run.sh prompt_for` (say so; it is not a file), `{{LAUNCH_LINE}}` = the runner-only
  command (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000 setsid nohup bash "<RUN_SH>" --config "<NIGHT_DIR>/config.env" --deadline "<DEADLINE>" </dev/null >> "<NIGHT_DIR>/logs/console.log" 2>&1 &`, the same RUN_SH
  as launch.sh; never `launch.sh`, which is the owner's bedtime command and re-installs settings), `{{LEVEL}}` = 0, `{{STATE_FILE}}` = `<night dir>/night-watch-state.md`, `{{SUMMARY_FILE}}` =
  `<night dir>/night-watch-summary.md`, `{{ESCALATION_MODEL}}` = entry [0] of the reviewer allow-list,
  `{{ALLOWLIST}}` = the four lines below verbatim. Leave `{{EVENT}}` and `{{FACTS}}` in place: the
  watchdog fills them per tick.
  ```
  - at L0: edit the session prompt template for the NEXT stories (log the diff), relaunch the runner from
    the launch line minus finished stories, `claude -p --resume <id>` a session that exited cleanly without
    its RESULT line (one time, 10 min cap), kill a session older than 45 min that is provably stuck.
  - at L2/L3: read-only plus messaging; a guard-file edit would park the sprint.
  - always: `git stash push -m "night-watch <HH:MM> orphaned wip"` when the tree has tracked changes and
    no story session is running; never reset, checkout, push or touch main.
  - never: runner scripts, hooks, settings, `.git/**`, review-queue ledger, a session under 45 min.
  ```
- `SUPERVISE-PROMPT.md`, rendered from `templates/SUPERVISE-PROMPT.md.tmpl` into
  `<NIGHT_DIR>/SUPERVISE-PROMPT.md` on EVERY plan (the 30-minute supervisor, PHASE E, reads it per
  tick). Literal `str.replace`, like `launch.sh`: `{{PROJECT}}`, `{{NIGHT_DIR}}`, `{{BASE}}`,
  `{{REPO}}`, `{{BASE_BRANCH}}`, `{{REQUIRED_CHECK}}`, `{{DISK_FLOOR_GB}}` from `config.env`;
  `{{WATCH_MAX_RESTARTS}}` = config `WATCH_MAX_RESTARTS` (2 when unset); `{{STATE_FILE}}` =
  `<NIGHT_DIR>/night-watch-state.md` (the triage tick's state file, the same value as in
  WATCHER-BRIEF.md). Then `/usr/bin/grep -o '{{[A-Za-z_0-9]\+}}' "<NIGHT_DIR>/SUPERVISE-PROMPT.md"`
  must print nothing: an unrendered placeholder is a PHASE C failure (BLOCKER at the gate), exactly
  as for the other templates — and `supervise.sh` refuses such a prompt at every tick
  (`SUPERVISE MISCONFIGURED ... missing or unrendered`), so the supervisor would do nothing all night.
- `BRIEF.md`, rendered from `templates/BRIEF.md.tmpl` in three steps, in this order.

  **1. Substitute these THIRTEEN placeholders, and only these thirteen.**
  `{{PROJECT}} {{REPO}} {{BASE}} {{BASE_BRANCH}} {{BRANCH_PREFIX}} {{NIGHT_DIR}} {{MODEL}}
  {{REQUIRED_CHECK}} {{PER_STORY_TIMEOUT}}` come from the same-named `config.env` fields;
  `{{NIGHT_RULES}}` is the full body of the project's `docs/NIGHT-RULES.md`, verbatim;
  `{{RUN_DATE}}` is `date +%F` of the night being planned;
  `{{REVIEWER_MODEL}}` is entry [0] of the reviewer allow-list (the `--first` read above);
  `{{QUEUE_TABLE}}` is the ordered queue as a markdown table whose header row is exactly
  `| id | size | needs | criteria |` —
  **escape every `|` inside a cell as `\|`**. Criteria routinely contain pipes
  (`sort -u | wc -l`, a literal `a|b`), and one unescaped pipe splits the row: the proven
  case rendered SIX cells instead of four, with the criteria cell ending mid-word at
  ``Export must emit `a`` — and a reviewer grading that fragment returns a genuine pass.

  **HOW to substitute — `{{NIGHT_RULES}}` is a whole FILE BODY, not a word.** A
  `sed 's|…|…|'` cannot carry it: the body has NEWLINES (sed's replacement text is one
  line), and a `&` or a `\1` anywhere in the rules re-inserts the match instead of itself —
  `run.sh` carries a `sed_repl` escaper for exactly this class of bug. Render the whole file
  with LITERAL string replacement instead, which has no metacharacters at all:

  ```bash
  python3 - ~/night-runs/<project>/BRIEF.md <BASE>/docs/NIGHT-RULES.md <<'PY'
  import sys
  brief, rules = sys.argv[1], sys.argv[2]
  body = open(rules).read()                   # verbatim: newlines, &, backslashes and all
  src  = open(brief).read()
  assert src.count('{{NIGHT_RULES}}') == 1, 'expected exactly one {{NIGHT_RULES}}'
  src = src.replace('{{NIGHT_RULES}}', body)  # str.replace: BOTH sides literal
  # ... the other twelve single-line values exactly the same way, e.g.
  # src = src.replace('{{PROJECT}}', project)
  open(brief, 'w').write(src)
  PY
  ```

  **These FIVE are RUNNER-OWNED: DO NOT SUBSTITUTE THEM, and never invent values.**
  `{{STORY_DEADLINE_EPOCH}} {{STORY_FINALIZE_EPOCH}} {{CI_WAIT_MINUTES}} {{GIT_USER_NAME}}
  {{GIT_USER_EMAIL}}`. run.sh substitutes all five per story, with literal values, into
  `$NIGHT_DIR/BRIEF-<id>.md`. They are per-story or per-run facts you cannot know: a
  hardcoded `STORY_DEADLINE_EPOCH` gives every story of the night the SAME already-past
  deadline, so each one believes it is out of time on its first compare. `GIT_USER_NAME`
  and `GIT_USER_EMAIL` are real `config.env` fields — that is exactly the trap; they are
  still the runner's to render. `CI_WAIT_MINUTES` likewise comes from `config.env`
  (default 45) and from nowhere else: the runner never reads `docs/NIGHT-RULES.md`, so a
  CI-wait number written there is silently ignored.

  **2. Strip the renderer-only comment block.** The template opens with an HTML
  comment addressed to you, which tells the reader "THE SKILL STRIPS THIS ENTIRE COMMENT AT
  RENDER TIME" — a sentence that is false unless you actually do it, at the top of a file
  the session is ordered to obey literally. The block starts on line 1 and ends on its own
  `-->` line; `1,/re/d` stops at the FIRST match, so this is non-greedy by construction:

  ```bash
  head -1 ~/night-runs/<project>/BRIEF.md            # must print exactly: <!--
  sed -i '1,/^-->[[:space:]]*$/d' ~/night-runs/<project>/BRIEF.md
  head -3 ~/night-runs/<project>/BRIEF.md            # must now start with "# <project> night run"
  ```

  If `head -1` is not `<!--`, the template changed: STOP and report it, do not improvise a
  different strip.

  **3. GATE on leftover placeholders — this check lives HERE and nowhere else.** The story
  session must not do it (a session cannot tell a render bug from its own instructions, and
  a self-check it can satisfy by quitting ends every night in 30 seconds), and run.sh only
  makes it fatal for its own per-story render. Nothing is launched until this prints
  nothing:

  ```bash
  /usr/bin/grep -o '{{[A-Za-z_0-9]\+}}' ~/night-runs/<project>/BRIEF.md | sort -u \
    | /usr/bin/grep -vx '{{\(STORY_DEADLINE_EPOCH\|STORY_FINALIZE_EPOCH\|CI_WAIT_MINUTES\|GIT_USER_NAME\|GIT_USER_EMAIL\)}}'
  ```

  Match by TOKEN (`grep -o`), never by line: a line that carries a real leftover next to a
  runner-owned one would be filtered away whole. The character class includes digits on
  purpose. To locate a token the gate printed: `/usr/bin/grep -n '{{NAME}}' .../BRIEF.md`.

  Any line of output is a RENDER BUG: fix it and re-render. Do not proceed to PHASE D, do
  not hand the file to the owner, and never "explain" a leftover token in the gate summary.
  The five runner-owned names are the only exemption. A surviving `{{NIGHT_RULES}}` is
  almost always a BROKEN SUBSTITUTION, not a bad scaffold: `NIGHT-RULES.md.tmpl` spells that
  name WITHOUT its braces on purpose, so a freshly scaffolded project file CANNOT carry the
  token. Re-do step 1 with the literal-replace method above — a `sed` that met the body's
  newlines or an `&` is the usual cause. Check the project's own file only after that, and
  only because an OLD hand-edited one may still carry it:
  `/usr/bin/grep -n '{{NIGHT_RULES}}' <BASE>/docs/NIGHT-RULES.md` — a hit there does
  re-inject a live placeholder, and must be deleted from the project's file.

`config.env` is NOT rendered here — PHASE A step 0 created and validated it, because steps
3-5 and the thirteen placeholders above read it. If it is still missing at this point, step 0
was skipped: go back and do it, do not improvise values. Render only
`settings.local.json`, from `templates/settings.local.json.tmpl`, for PHASE E to install.
The JSON template is NOT copy-ready and its own `_comment_placeholders` says what it needs:

- `<BASE_BRANCH>` and `<BRANCH_PREFIX>` from `config.env`, `<project>` from `PROJECT`, and
  `<NIGHT_DIR>` / `<BASE_DIR>` from `config.env`'s `NIGHT_DIR` and `BASE` — ABSOLUTE, no
  trailing slash, NEVER `~`: a `Bash(...)` rule is matched against the raw command text, so a
  `~` in the rule only ever matches a literal tilde. These two scope the `git -C` allow rules
  to the run's own trees; unscoped, `-C *` reached every git repo on this shared machine.
- ONE `Edit(<glob>)` deny line per forbidden path in `docs/NIGHT-RULES.md` section 3, and
  one `Read(<glob>)` deny line per secret file. This translation is section 3's ONLY
  enforcement channel — sections 1, 5 and 6 are wired into the brief, section 3 is prose
  until you turn it into rules. Env files are denied by explicit name (`.env`, `.env.local`,
  `.env.*.local`, `.env.production*`, `.env.development*`, `.env.test*`, `.env.staging*`),
  never `.env.*`, which also denies the tracked `.env.example`. Never write a `[!x]` class:
  measured on Claude Code 2.1.288, `.env.[!e]*` denied `.env.example` and allowed `.env.local`.
- The deployed-tree lines: the real path, or delete them. In a file rule a single leading
  `/` is resolved relative to `<BASE>` and therefore matches NOTHING; write `~/...` for
  home paths and a DOUBLED `//...` for anything else.
- `<PR number the run must never merge>` from NIGHT-RULES section 1, or delete the line.

Then run the post-render step. It does two mechanical things in place, after the section-3
lines are in: (1) Story worktrees: a repo-relative `Edit(<glob>)`/`Read(<glob>)` deny
resolves against the session cwd (`BASE`), but stories work in `<NIGHT_DIR>/wt/<id>`, so
every repo-relative one (its glob does not start with `~` or `/`; a leading `./` is dropped)
gets a mirror `Edit(//<NIGHT_DIR without its leading slash>/wt/*/<glob>)` / `Read(...)`. A
slash-less glob (trailing `/` ignored) matches at any depth in `BASE`, so its mirror is
`.../wt/*/**/<glob>`. (2) NIGHT-RULES section 7's docker line — `docker: denied`, also the
default when the line is missing, keeps the template's blanket `Bash(*docker *)` /
`Bash(*docker-compose*)` denies; `docker: allowed, container prefix <prefix>` removes both,
adds the scoped allows (container logs/exec/restart by prefix, throwaway `night-*`
containers and compose projects, build, pull) AND adds denies: one `Bash(*docker*<name>*)`
per name on section 7's "Never stop or restart" line (per comma-separated item, `(note)`s
dropped: every backticked token, else the item's single word, several plain words being
unparseable; a name must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`), plus `-v `, `--volume`, `--mount`,
`--privileged`, `docker.sock` and `prune`. Story sessions run in auto mode and a deny always
beats an allow; a Bash rule's `*` also matches spaces, so `docker rm -f night-*` alone would
approve `docker rm -f night-x prod-db` — the denies are what protect the neighbours. They are
a pattern guard, not a security boundary: docker is root-equivalent on the host, and a
mount written in a compose file is not caught. The docker step first strips every docker
allow and every `Bash(*docker...` deny, then adds the current choice, so re-running it is
idempotent and switching section 7 back to `denied` restores the blanket denies. Both
snippets import the shared helpers from `nr_rules.py`, written first:

```bash
cat > /home/ubuntu/night-runs/<project>/nr_rules.py <<'NRLIB'
# Shared by the PHASE C post-render step and the rules check, so the two cannot drift apart.
import re
BLANKET = ("Bash(*docker *)", "Bash(*docker-compose*)")   # the template's docker denies, kept for `docker: denied`
def repo_relative(r):  # Edit(<glob>)/Read(<glob>) not starting with ~ or / -> (kind, glob without a leading ./), else None
    m = re.fullmatch(r"(Edit|Read)\(([^~/].*)\)", r)
    return m and (m[1], m[2][2:] if m[2].startswith("./") else m[2])
def mirror(kind, night, g):  # the story-worktree mirror; a slash-less glob matches at any depth, so it keeps that via **/
    return "%s(/%s/wt/*/%s%s)" % (kind, night, "" if "/" in g.rstrip("/") else "**/", g)
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
def never_stop(line):  # section 7 "Never stop or restart" line -> (names, items with no valid name)
    names, bad = [], []
    for item in re.split(r",(?=(?:[^`]*`[^`]*`)*[^`]*$)(?![^()]*\))", line):  # no split inside a (note) or `span`
        item = item.strip()
        core = re.sub(r"\([^()]*\)", " ", item)     # a (note) is dropped first, backticks inside it included
        ticks = re.findall(r"`([^`]*)`", core)
        rest = re.sub(r"`[^`]*`", " ", core).strip(" `.,;:!?")
        if ticks:   # every backticked token is a name; outside them only separators may stand
            ws = [w for t in ticks for w in re.split(r"[\s,/]+", t) if w]
            ok = not re.sub(r"(?i)\b(?:and|or)\b|[\s/&+.,;:!?]", "", rest)
        else:       # a plain item is exactly one name, else it is unparseable rather than guessed
            ws = rest.split()
            ok = len(ws) == 1
        if not item or ok and [w.lower() for w in ws] == ["none"]:
            continue
        if ok and ws and all(NAME.fullmatch(w) for w in ws):
            names += ws
        else:
            bad.append(item)
    return names, bad
def docker(md):  # NIGHT-RULES section 7 -> (prefix, allows, denies, never-stop names, unparseable items) when allowed; else None
    try:
        sec = re.split(r"(?m)^## 7\.", open(md, encoding="utf-8").read(), maxsplit=1)[1].split("\n## ", 1)[0]
    except (OSError, IndexError):
        return None
    m = re.search(r"docker:\s*`?allowed,\s*container prefix\s+`?([A-Za-z0-9][A-Za-z0-9_.-]*)", sec)
    if not m:
        return None
    p, n = m[1], re.search(r"(?m)^\s*-\s*Never stop or restart:(.*)$", sec)
    names, bad = never_stop(n[1] if n else "")
    allow = ["Bash(docker ps*)", "Bash(docker logs %s-*)" % p, "Bash(docker exec %s-*)" % p,
             "Bash(docker restart %s-*)" % p, "Bash(docker run --rm --name night-*)", "Bash(docker rm -f night-*)",
             "Bash(docker compose -p night-* *)", "Bash(docker build *)", "Bash(docker pull *)"]
    deny = ["Bash(*docker*%s*)" % x for x in names] + [
        "Bash(*docker*-v *)", "Bash(*docker*--volume*)", "Bash(*docker*--mount*)", "Bash(*docker*--privileged*)",
        "Bash(*docker*docker.sock*)", "Bash(*docker*prune*)"]
    return p, allow, deny, names, bad
NRLIB
python3 - /home/ubuntu/night-runs/<project>/settings.local.json <NIGHT_DIR> <BASE>/docs/NIGHT-RULES.md <<'POST'
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])))
from nr_rules import BLANKET, docker, mirror, repo_relative
f, night, md = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3]
s = json.load(open(f, encoding="utf-8"))
p = s["permissions"]
for r in list(p["deny"]):
    rr = repo_relative(r)
    if rr and mirror(rr[0], night, rr[1]) not in p["deny"]:
        p["deny"].append(mirror(rr[0], night, rr[1]))
p["allow"] = [r for r in p["allow"] if "docker" not in r]          # strip every earlier docker choice ...
p["deny"] = [r for r in p["deny"] if not r.startswith("Bash(*docker")]
dk = docker(md)                                                    # ... then add the current one
p["allow"] += dk[1] if dk else []
p["deny"] += dk[2] if dk else list(BLANKET)
json.dump(s, open(f, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print("docker:", "allowed, prefix " + dk[0] if dk else "denied", "| deny", len(p["deny"]), "| allow", len(p["allow"]))
POST
```

Read its `docker:` line back against section 7: `denied` while the owner wrote `allowed` means
the line is not in the `docker: allowed, container prefix <prefix>` form — fix the file, re-run.
Under `allowed`, every backticked token on the never-stop line is a name (`` `a` `b` ``,
`` `a` / `b` `` both give two); a plain item without backticks must be one name plus an
optional `(note)`. An item that yields no valid name (an unfilled `<name>` placeholder,
`(see wiki)`) or is several plain words (`main postgres db`, `a / b`) renders no deny and
fails the rules check with `NEVER-STOP NAME UNPARSEABLE: <item>`: fix it (or write `none`).
Then prove the render, with the `~` expanded:

```bash
python3 -c "import json;json.load(open('/home/ubuntu/night-runs/<project>/settings.local.json'))" && echo JSON_OK
python3 - /home/ubuntu/night-runs/<project>/settings.local.json <BASE> <NIGHT_DIR> <BASE>/docs/NIGHT-RULES.md <<'PY'
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])))
from nr_rules import BLANKET, docker, mirror, repo_relative
perms = json.load(open(sys.argv[1]))["permissions"]
base, night = sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/")   # config.env BASE / NIGHT_DIR, absolute
rules = perms.get("allow", []) + perms.get("deny", []) + perms.get("ask", [])
bad = [r for r in rules if re.search(r"<[A-Za-z]", r)]
for r in bad:
    print("UNRENDERED RULE:", r)
def rx(g):  # gitignore-style: ** crosses '/'; *, ? and [a-z] / [!a-z] do not
    def tok(x):
        if len(x) > 2 and x[0] == "[":
            neg = x[1] in "!^"
            return "[" + ("^/" if neg else "") + x[1 + neg:-1].replace("\\", "\\\\") + "]"
        return {"**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]"}.get(x) or re.escape(x)
    return re.compile("".join(tok(x) for x in re.findall(r"\*\*/|\*\*|[*?]|\[[!^]?[^\]/]+\]|[^*?]", g)) + r"\Z")
def path(g):  # '~/' = $HOME, '//' = absolute root, else BASE-relative ('./x' = 'x'); no inner '/' = any depth
    g = g.rstrip("/") or g
    if g.startswith("~/"):
        return os.path.expanduser(g)
    if g.startswith("//"):
        return g[1:]
    g = g[2:] if g.startswith("./") else g
    return base + ("/" if "/" in g else "/**/") + g.lstrip("/")
def up(p):  # the probe and every directory above it: a deny on a directory covers everything beneath it
    while p:
        yield p
        p = p.rpartition("/")[0]
probes = [base + "/runtime/" + f for f in ("AUTOPILOT-REPORT.md", "DECISIONS.md", "handoff/night-S1.md",
                                           "handoff/night-latest.md")] + [night + "/wt/S1/file", night + "/wt/S1/src/index.ts"]
hits = [r for r in perms.get("deny", [])
        if (m := re.fullmatch(r"(?:Edit|Write)\((.*)\)", r))
        and any(rx(path(m[1])).match(a) for p in probes for a in up(p))]
for r in hits:
    print("DENY COVERS RUN TREE:", r)
deny, allow = perms.get("deny", []), perms.get("allow", [])
def denied(kind, p):  # a <kind> deny covers the path p or a directory above it
    return any((m := re.fullmatch(kind + r"\((.*)\)", r)) and any(rx(path(m[1])).match(a) for a in up(p)) for r in deny)
wt = []   # every repo-relative Edit/Read deny needs its story-worktree mirror, and a wildcard-free one must deny there
for r in deny:
    rr = repo_relative(r)
    if not rr:
        continue
    kind, g = rr
    if mirror(kind, night, g) not in deny:
        wt.append(r)
        print("MISSING WT MIRROR:", r)
    g = g.rstrip("/")
    if not re.search(r"[*?[]", g):   # a slash-less one matches at any depth, so a nested path is probed too
        for q in [night + "/wt/S1/" + g] + ([] if "/" in g else [night + "/wt/S1/apps/x/" + g]):
            if not denied(kind, q):
                wt.append(r)
                print("WT PATH NOT DENIED: %s -> %s" % (r, q))
def bash_denied(c):  # a Bash(...) deny matches command c: anchored, every '*' crosses spaces, ':*' = ' *', the rest literal
    for r in deny:
        if m := re.fullmatch(r"Bash\((.*)\)", r):
            b = m[1][:-2] + " *" if m[1].endswith(":*") else m[1]
            if re.fullmatch(".*".join(map(re.escape, b.split("*"))), c, re.S):
                return True
    return False
dk = docker(sys.argv[4] if len(sys.argv) > 4 else "")
unparsed = dk[4] if dk else []
for u in unparsed:
    print("NEVER-STOP NAME UNPARSEABLE:", u)
if dk:
    dock = ["docker allowed in section 7, blanket deny still rendered: " + r for r in deny if r in BLANKET]
    dock += ["docker allowed in section 7, rule missing: " + r for r in dk[1] + dk[2] if r not in allow + deny]
    dock += ["docker allowed in section 7, never-stop name not denied: " + c for n in dk[3]
             for c in ("docker rm -f night-x " + n, "docker restart %s-a %s" % (dk[0], n)) if not bash_denied(c)]
else:
    dock = ["docker denied in section 7, docker allow rendered: " + r for r in allow if "docker" in r]
    dock += ["docker denied in section 7, blanket deny missing: " + r for r in BLANKET if r not in deny]
    dock += ["docker denied in section 7, deny left from allowed: " + r for r in deny
             if r.startswith("Bash(*docker") and r not in BLANKET]
for d in dock:
    print("DOCKER RULE MISMATCH:", d)
sys.exit(1 if bad or hits or wt or dock or unparsed else 0)
PY
echo "rules rc=$?"   # 0 = every rule rendered, no Edit/Write deny covers the run's own trees, every repo-relative Edit/Read deny is mirrored into wt/*, docker matches section 7, every never-stop name parsed and denied; anything else = the lines above
```

`<BASE>` and `<NIGHT_DIR>` are config.env's `BASE` and `NIGHT_DIR`, absolute (the same values
that scope the `git -C` allow rules). The second check exists because the run's own sessions
must be able to write in `<BASE>/runtime/` (`AUTOPILOT-REPORT.md`, `DECISIONS.md`, `handoff/night-*.md`) and in
`<NIGHT_DIR>/wt/<id>/`: a section-3 `Edit(<glob>)` line that covers any of those (e.g. an
innotel `Edit(~/bss-*/**)` next to `BASE=~/bss-night`) prints `DENY COVERS RUN TREE: <rule>`
and fails the render. Narrow the glob to the protected subtree, or drop the rule. The same
probe list holds `<NIGHT_DIR>/wt/S1/src/index.ts`, so a mirror that would freeze ordinary
story code fails the same way. The third check fails with `MISSING WT MIRROR: <rule>` for a
repo-relative `Edit`/`Read` deny the post-render step did not mirror, and with
`WT PATH NOT DENIED: <rule> -> <NIGHT_DIR>/wt/S1/<glob>` when a wildcard-free one does not
actually deny that worktree path, or for a slash-less one the nested
`<NIGHT_DIR>/wt/S1/apps/x/<glob>` (re-run the post-render step). The fourth takes
`<BASE>/docs/NIGHT-RULES.md` as its last argument and fails with
`DOCKER RULE MISMATCH: <why>` when section 7 says `allowed` but a blanket docker deny is still
rendered, a scoped allow / never-stop / mount deny is missing, or a probe
`docker rm -f night-x <name>` / `docker restart <prefix>-a <name>` is not denied for a parsed
never-stop name, or says `denied` (or nothing) while an allow rule names docker, a blanket
deny is missing or a deny the `allowed` choice added is left. Under `allowed` it also fails
with `NEVER-STOP NAME UNPARSEABLE: <item>` for a never-stop item that yields no valid name
or is several plain words.
All three heredocs are proved by
`bajzi/skills/night-run/tests/deny-run-tree.sh`, which extracts and runs them.

**The check is scoped to the RULES, never to the whole file, and that is load-bearing.** A
whole-file `grep '<[A-Za-z]'` is UNSATISFIABLE: on a PERFECT render it still returns 6 hits,
every one of them inside the `_comment*` documentation keys, which legitimately spell
`<BASE>`, `<glob>`, `<dir>`, `<stamp>`, `<angle-bracket>`, `<RUN_DATE>`, `<id>`, `<date>`
and `<project>`. Faced with a check that cannot pass, an agent either deletes those comment
blocks — destroying the measured matcher and symlink knowledge the file exists to carry —
or learns to wave the hits through; and the next thing waved through is a REAL leftover
(`Edit(//<absolute path of the deployed tree…>/**)`, the section-3 line, or
`<PR number the run must never merge>`) sitting inside `permissions.deny` matching NOTHING,
with section 3 then unenforced for the whole night. The JSON-scoped check above returns
nothing on that same perfect render and NAMES every leftover on a bad one.

**Re-render rule — a plan never outlives the base it was rendered from.** If a NIGHT-RULES
change, or any PR the plan depends on (a `needs` PR, a rules or CI fix), is MERGED while you
are planning, the render is stale. Before the PHASE D gate: fetch again, fast-forward BASE's
`night/base-<stamp>` branch (confirm `git -C "<BASE>" branch --show-current` starts with
`night/base-`, else BLOCKER) and rewrite `<NIGHT_DIR>/render-base.sha`:

```bash
/usr/bin/git -C "<BASE>" fetch origin <BASE_BRANCH>
/usr/bin/git -C "<BASE>" merge --ff-only "origin/<BASE_BRANCH>"
/usr/bin/git -C "<BASE>" rev-parse "origin/<BASE_BRANCH>" > "<NIGHT_DIR>/render-base.sha"
```

A failing `--ff-only` is a BLOCKER (never reset or rebase BASE). Then RE-RENDER everything that
read BASE or the plugin: `BRIEF.md` (all three steps, `{{NIGHT_RULES}}` first), the
post-render step and rules check of `settings.local.json`, and `launch.sh` (with the check
above). Re-read the queue against the changed rules too. A re-render that is skipped sends
the owner to bed with the old rules.

## PHASE D — Approval gate

ONE screen, and it is the ONLY question this skill asks. The run merges to the base branch
for hours while the owner sleeps, so the gate is not optional. Show:

1. the ordered queue — each item with its size and ONE line of why it is in;
2. what the run may merge unattended per the NIGHT-RULES merge policy, plus the reminder
   that **every item passes the Opus review-and-fix loop and must be review-green AND
   CI-green before anything is merged**;
3. what was deferred, and why; 4. every blocker PHASE A found;
5. one line that the PHASE C render gate came back clean: no leftover `{{placeholder}}` in
   `BRIEF.md`, `settings.local.json` is valid JSON, and the rules check over
   `permissions.allow + permissions.deny + permissions.ask` printed no `UNRENDERED RULE:`, no `DENY COVERS RUN TREE:`, no `MISSING WT MIRROR:`, no
   `WT PATH NOT DENIED:`, no `DOCKER RULE MISMATCH:` and no `NEVER-STOP NAME UNPARSEABLE:` line (`rules rc=0`), plus the
   docker choice the post-render step printed (`docker: denied` or `docker: allowed, prefix <prefix>`).
   Say it in those words. The `_comment*` keys of `settings.local.json` DO still contain
   `<angle-bracket>` text and that is correct — they are documentation, they are not rules,
   and they are outside the check on purpose. If the rules check did not come back 0, you
   are not at this gate yet.
6. one line that `launch.sh` was rendered in this plan and its check printed nothing (the
   PHASE C `launch.sh` check, run again now): `RUN_SH` exists and equals the current plugin
   root's `skills/night-run/run.sh`; quote the path;
7. one line `Rendered from origin/<BASE_BRANCH> @ <SHA>` with the SHA from
   `<NIGHT_DIR>/render-base.sha`, and the BASE branch `night/base-<stamp>` it sits on. Run a
   fresh `/usr/bin/git -C "<BASE>" ls-remote origin "refs/heads/<BASE_BRANCH>"` right before
   showing the screen: when it prints a SHA other than the rendered one, the gate REFUSES
   (`STALE RENDER: rendered <SHA>, origin now <SHA2>`): go back to the re-render rule, do not
   show an approval question.
The owner approves or edits once. Then go to PHASE E.

## PHASE E — Launch (the owner's step)

You never launch the runner: a Claude session is denied by the auto-mode classifier
(Interfere With Workloads). Emit the block below with EVERY `<...>` already filled in from
`config.env` — never ask the owner for a value you can resolve, say where you took it from
instead. The commands that install the allowlist and start the runner are NOT typed here: they
are in `<NIGHT_DIR>/launch.sh`, which PHASE C rendered in this plan from
`templates/launch.sh.tmpl` (its `run.sh` is the one of the plugin copy running this skill).

> **Where:** this VM, a plain **bash** terminal outside Claude Code — not the Claude prompt, not `!`.
> **Working directory:** any (`launch.sh` does `cd <BASE>` itself; `<BASE>` is the `BASE` field of `config.env`)

**Step 1 — launch.** One command:

```bash
bash <NIGHT_DIR>/launch.sh
```

What `launch.sh` does, in order: refuses to start when a runner already holds
`<NIGHT_DIR>/run.flock` (printing the `run.lock` content); backs up an existing
`<BASE>/.claude/settings.local.json` to `settings.local.json.pre-night-<stamp>` and, when that
copy fails, prints `BACKUP FAILED — nothing was overwritten` and stops; installs
`<NIGHT_DIR>/settings.local.json`; exports `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000`;
starts `run.sh` with `setsid nohup`, stdin from `/dev/null`, output to `logs/console.log`;
shows the first `runner.log` lines. A plain `cp` of the settings would replace the owner's
project settings silently, which is why the backup comes first.

> **Success:** `ls` lists `settings.local.json`, plus a `settings.local.json.pre-night-<stamp>`
> if you had one before — that backup is what you move back in the morning, instead of just
> deleting the file. If you see `BACKUP FAILED`, STOP: nothing was overwritten and nothing
> was launched. `A runner is ALREADY running` also means nothing was launched: read the
> `run.lock` pgid it printed, and do not start another.

**Step 2 — check that exactly one runner started.**

```bash
cd <BASE>
CFG=~/night-runs/<project>/config.env
pids=$(pgrep -f 'run\.sh'); rc=$?   # 0=hits 1=none >1=the SCAN itself failed
[ "$rc" -le 1 ] || echo "RUNNER SCAN FAILED (pgrep rc=$rc) — this is NOT 'nothing started'"
for p in $pids; do
  [ -r "/proc/$p/cmdline" ] || continue
  argv=$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null) || continue
  a0=$(printf '%s\n' "$argv" | sed -n 1p); a1=$(printf '%s\n' "$argv" | sed -n 2p)
  [ "${a1##*/}" = run.sh ] || [ "${a0##*/}" = run.sh ] || continue
  printf '%s\n' "$argv" | /usr/bin/grep -qxF "$CFG" || continue
  awk '{print $5}' "/proc/$p/stat" 2>/dev/null
done | sort -u
```

`setsid` (inside `launch.sh`) is required, not cosmetic: `nohup` blocks SIGHUP but not the harness
killing the launching session's process group, so a `nohup`-only runner dies with the session.
The check is the argv test from PHASE A, scoped to this project — a plain `pgrep -af` pattern
would count the checking shell itself and print four or five numbers for one runner.

Fill `{{DEADLINE}}` yourself when you render `launch.sh` (PHASE C): it is the launch time plus
the `hours:` budget you actually queued, as `HH:MM`, and never later than 07:30. Say the
arithmetic out loud at the gate ("queued 5.5 h, launching ~23:00 → `--deadline 04:30`").
`--deadline` is the HARD stop; if `hours:` would run past it, queue less and say so at the
PHASE D gate — a 02:00 launch with `hours:8` puts eight hours of work into a 5.5-hour window
and the rest is simply parked.

> **Success:** the last command prints exactly ONE pgid, and it is a NEW number, not one you
> saw in PHASE A. If it prints `RUNNER SCAN FAILED`, the check broke, NOT the launch: do NOT
> run `launch.sh` again — that is how a second runner ends up in one worktree (its flock check
> would refuse, but do not rely on it). Read
> `tail ~/night-runs/<project>/logs/runner.log` instead, and fix `pgrep` first.
> On a clean ONE-pgid result, `tail ~/night-runs/<project>/logs/runner.log` then shows
> `RUN start` followed by `START <first id>`.
> **Likeliest failure:** `launch.sh` prints `run.sh not found: <path>`. The plugin copy it was
> rendered from is gone (an update replaced it): run `/bajzi:night-run` again so PHASE C renders
> `launch.sh` anew; never edit the path by hand.
> **Second likeliest:** the pgid check prints nothing and `console.log` ends with
> `run.sh: config file not found`. Fix: check the path with
> `ls -l ~/night-runs/<project>/config.env`, then re-render `launch.sh` and run it again.
> **`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`: export a LARGE value (e.g. `3600000`, one hour) for the
> runner, never 0.** It is how long headless claude waits for a pending background task after the
> session yields; the default is 600 s and 0 means no wait at all, so a session that yields while a
> gate runs in the background exits immediately and its RESULT line is never written.
> **Kill switch, any time:** `touch ~/night-runs/<project>/STOP`, checked between stories.

**The watchdog starts itself.** `run.sh` spawns `night-watch.sh` (next to it) detached as soon
as it holds the run lock — the owner launches nothing extra. It is pure bash and costs ZERO
model tokens, on purpose: a Claude-based watcher would spend the very quota it is there to
watch. Every `WATCH_INTERVAL` seconds (900 by default; `WATCH_INTERVAL="0"` in `config.env`
turns it off) it appends one status line to `~/night-runs/<project>/watch.log` — runner alive
or dead, heartbeat age, free disk, quota wait, queue progress — restarts a dead runner up to
`WATCH_MAX_RESTARTS` times from `run.args`, and creates `STOP` if free disk falls under
`DISK_FLOOR_GB`. It never deletes anything and never signals a story process. The night's
directory is PERMANENT, so it DATES every marker against `run.meta`'s `started_epoch`: a
`finished` or `watch.restarts` left by an earlier night is logged once and ignored
(otherwise the second night's watcher would read yesterday's `finished` seconds after
starting and leave the runner unwatched). `STOP` is dated more generously — against the
EARLIER of `started_epoch` and the watcher's own start — because a restart rewrites
`started_epoch` and a `STOP` you dropped seconds before it is still tonight's. The restart
BUDGET is counted in the watcher's memory, which outlives every runner it restarts;
`watch.restarts` is only a crash hint, read once at start. A run it cannot date — no
`run.meta`, no usable `started_epoch` — is reported `UNKNOWN` and nothing is restarted.

**Tier 1, the triage watcher, is the only part that thinks — and it costs tokens only on an
event.** With `WATCH_TRIAGE=1` (the default when `WATCHER-BRIEF.md` exists) the watchdog spawns ONE
detached headless tick — `claude -p --model $WATCH_TRIAGE_MODEL --permission-mode bypassPermissions`
run with cwd = BASE, an explicit `--settings $BASE/.claude/settings.local.json` and `--output-format
stream-json --verbose` (raw stream in `triage/<epoch>-<pid>.jsonl`, stderr in `triage/<id>.err`), 10 min
cap, decoded result in `triage.log` — every time `state.txt` gains a new terminal row. The tick gets the
brief with the new rows as `{{EVENT}}` and the log tails as `{{FACTS}}`; it classifies EXPECTED vs
ANOMALY mechanically, root-causes an anomaly within a fixed budget (one transcript tail; a sub-agent on
the reviewer model only when that is not enough), acts inside the allowlist you rendered into the brief
(prompt-template edit at L0, relaunch, one `--resume`, orphan stash) and, for a BLOCKING failure with a
proven environment/test-harness cause (duty 4), may make one `night-watch fix:` commit and end with
`TICK FIXED fp=<fp> commit=<sha>`, the only line tier 0 relaunches on. It fails closed: the stream's init
record is checked (model prefix, permission mode bypassPermissions) and a mismatch, no init, a missing
BASE or settings file, or an unsupported `WATCH_TRIAGE_MODEL` (only `sonnet`/`opus`/`haiku` or a full
`claude-*` id) logs `TICK MISCONFIGURED` and no claude result reaches `triage.log`; a run without a
result line or a non-zero exit logs `TICK FAILED`. It appends one line per tick to
`night-watch-state.md`. The last tick, on the queue end, writes `night-watch-summary.md` with a Lessons
section. It never polls: the 2026-09-25 lesson was a watcher that logged "no status file" at 03:34 and
waited for morning; the brief now tells it to diagnose and act.

**The 30-minute supervisor watches the LIVE story.** Triage wakes only on a terminal row, so a story
stuck in its first 20 minutes would be noticed only when its budget ends. With `SUPERVISE=1` (the
default; `0` disables) `run.sh` spawns `supervise.sh` next to the watchdog (same detached spawn:
setsid, no run-lock fd, stdin `/dev/null`, output in `logs/supervise.out`). It SLEEPS FIRST for
`SUPERVISE_INTERVAL` (1800 s), then per iteration re-reads `started_epoch` from `run.meta` and exits —
one line in `~/night-runs/<project>/supervisor.log` — on `SUPERVISE-STOP`, on `STOP`, or when `finished`
holds an epoch >= `started_epoch`; otherwise it runs ONE fresh headless tick with `SUPERVISE-PROMPT.md`:
model = entry [0] of the reviewer allow-list read at that tick, `--permission-mode bypassPermissions`,
cwd = the night dir, `SUPERVISE_TICK_TIMEOUT` (1500 s, must be < the interval) hard cap, provider env
(`ANTHROPIC_*`, router selectors) scrubbed so it can never run on GLM, and the same fail-closed
stream-json init check as triage (`SUPERVISE MISCONFIGURED` in `supervisor.log`, tick killed, no result).
Each tick's result text and `<ISO> tick exit=<rc>` go to `logs/supervisor-ticks.log`; the tick itself
appends `<ISO> OK|FIXED|PROBLEM <story id> <sentence>` to `supervisor.log`. ONE supervisor per run
(`supervise.pid`): a tier-0 restart that re-runs `run.sh` spawns a second one, which exits at once.
Ownership: the supervisor owns allowlist edits (both `settings.local.json` copies) and code/harness
fixes via a PR merged only on a green `REQUIRED_CHECK` pull_request run; the triage tick never edits
settings. It relaunches (`launch.sh`, at most 2 per run) only when tier 0 cannot, and changes nothing
while a triage tick is alive or holds an open `FIXING`. **Stop the supervisor alone:**
`touch ~/night-runs/<project>/SUPERVISE-STOP` (checked after each sleep). The file is not dated: it
also stops the NEXT night's supervisor, so `rm` it before that launch.

## PHASE F — Morning follow-through (`report` mode)

Per spec section 5: read `~/night-runs/<project>/REPORT-<date>.md` and this run's
`~/night-runs/<project>/state-<date>.txt`.

**Resolve `<date>` first — do not guess it and never glob `state-*.txt`.** The report runs
the morning AFTER `RUN_DATE`, so `state-$(date +%F).txt` is yesterday's name and does not
exist; and `state-*.txt` also matches `state-before-<date>.txt`, the real `state.txt` an
OLDER runner left behind, which is NOT tonight's run. Take the symlink, and fall back to the
newest `state-2*.txt` (that glob cannot match `state-before-…`):

```bash
ND=~/night-runs/<project>
tgt=$(readlink "$ND/state.txt" 2>/dev/null)          # empty when it is not a symlink
STATE=""
[ -n "$tgt" ] && [ -f "$ND/${tgt##*/}" ] && STATE="$ND/${tgt##*/}"   # a DANGLING link is not a state file
[ -n "$STATE" ] || STATE=$(ls -1t "$ND"/state-2*.txt 2>/dev/null | head -1)
REPORT=$(ls -1t "$ND"/REPORT-2*.md 2>/dev/null | head -1)
RUN_DATE=${STATE##*/state-}; RUN_DATE=${RUN_DATE%.txt}
echo "state=$STATE report=$REPORT run_date=$RUN_DATE"
```

Empty `STATE` means no run wrote rows: say exactly that in the report and read nothing else
as a substitute. The `[ -f ... ]` test is what makes that branch reachable — a DANGLING
`state.txt` (the run was cleaned up under it) still gives `readlink` a non-empty name, and
without the test `STATE` would name a file that does not exist, the "no rows" branch would
be skipped, and the morning report would quietly read nothing. A `STATE` whose name contains `before` means the fallback was mis-typed —
stop and resolve it by hand. Then: review every still-open PR with
ONE Opus sub-agent each in the spec's verdict format, never in the main thread; merge only
PRs that are BOTH review-green and CI-green under the NIGHT-RULES merge policy — a PR the
night PARKED is re-reviewed, not waved through because it is morning; run the post-merge
invariants after each merge; clean up worktrees per spec section 8, KEEPING anything dirty,
unpushed or parked; refresh the deck and update the owner's single runbook list in place.

**Read `~/night-runs/<project>/watch.log` before the rows.** One line per watcher tick; what
matters is the STATUS TRANSITIONS — `QUOTA-WAIT`, `RESTARTED`, `DEAD`, `STALLED`, `DISK-LOW`,
`FINISHED`/`STOPPED`/`EXPIRED`, plus any `orphan sid=` lines. `UNKNOWN` means the watcher
itself went blind — no `flock`, a broken `pgrep`, or a `run.meta` it could not read or date —
so THAT TICK restarted nothing. `UNKNOWN` is a per-tick verdict, not a latch: the next tick
that can read `run.meta` is back to normal watching, so treat each `UNKNOWN` stretch — not
everything after it — as unsupervised time and check the runner's own logs across it. A night whose state rows stop
mid-queue is explained there, not in `state-<date>.txt`, and every transition belongs in the
morning report.

**Reading the rows.** A row is `<id> <rc|TOKEN> <ISO time> [reason]`. One id can have
SEVERAL rows — a `DEFERRED-needs` row from pass one plus a terminal row from pass two — and
**the LAST row for an id is its outcome**; the earlier rows are its history. Every id in the
file belongs in the report, none may be dropped. A numeric second field is a story that ran,
and the number is its exit code. Every other second field is a runner-side outcome:

- `BLOCKED-queue` — malformed queue line (bad id charset, missing or invalid slug). Fix the
  line before re-queueing it.
- `BLOCKED-criteria` — the queue line carried no acceptance criteria, so the story was never
  launched. Write real criteria into the line, then re-queue.
- `BLOCKED-needs` — the `needs` column held no PR number. A configuration error: fix the
  column.
- `BLOCKED-needs-unknown` — `gh` failed, so the runner could NOT tell whether the dependency
  PR merged. This is NOT "not merged": check the PR yourself, fix the `gh` auth, re-queue.
- `BLOCKED-brief` — the per-story brief could not be rendered, so the story never started.
  A render bug: no code was written, fix the render and re-queue.
- `BLOCKED-deadline` — no time left before the hard deadline. Re-queue it at the front of
  tomorrow's queue.
- `DEFERRED-needs` — the dependency PR was not merged in time. Non-terminal: if no later row
  for that id follows, the story never ran tonight and goes back into the queue unchanged.
- `DEFERRED-quota` — the model's usage limit cut that session short; the reason column
  carries `resets=<ISO-8601 UTC>`. NON-TERMINAL: the runner waits and re-picks the story in
  a later pass, so if a terminal row for that id follows, it ran. If none follows, it never
  ran tonight and goes back into the queue unchanged.
- `DEFERRED-quota-weekly` — the same, but the WEEKLY limit. Also non-terminal, and no night
  can wait it out: do NOT re-run before the weekly reset named in the reason column.
- `DEFERRED-alive` — the story was skipped this pass because its PREVIOUS session was still
  alive (reason `sid=<sid>`); non-terminal, so a later pass or the next night picks it up.
- `INTERRUPTED` — the runner was signalled and that story was killed mid-flight. Its worktree
  may be dirty or half-pushed, so keep it, inspect it, and re-queue the story.

**Reading the report.** `REPORT-<date>.md` is written in two layers. `run.sh` writes the
facts itself, with no model involved, so they exist even when the night ended on a usage
limit or a crash: `## Counts`, `## Stories` (one row per id, its LAST row), `## Quota` (the
`DEFERRED-quota*` lines and the moment launches were allowed again) and `## Runner facts`.
`## Narrative` is appended afterwards by one Claude session, and it is **absent when the
limit was still in force** — an absent narrative is not a failed report, it is the limit.
Finally, `~/night-runs/<project>/finished` (one epoch) is written as the LAST act of a real
QUEUE run, after the report — and DELETED again when the next queue run takes the night, so
it always belongs to the newest run that started. (A `--report` or `--smoke` run writes no
`finished` at all: it is not the night.) No `finished` file means the run did not end on its
own, so read `watch.log` for what happened to it. Check its CONTENTS, not just its presence
— an epoch older than this run's `started_epoch` is a marker the runner never cleared (the
watcher ignores it for exactly that reason).

**Token usage.** If `~/.claude/worker-mode` is `glm` and `worker` is on PATH, run
`worker --usage $RUN_DATE` and add its last two lines to the morning report under a
"Token usage (GLM vs Anthropic)" heading; skip silently if the command is missing.

## Closing report

Table: what was queued (id · size · why) · what was deferred and why · PHASE A blockers ·
the paths of the generated files (`config.env`, `queue.txt`, `BRIEF.md`,
`settings.local.json`, `launch.sh`) · whether `<BASE>/.claude/settings.local.json` already exists, so the
owner knows PHASE E will back it up rather than eat it. State plainly that nothing was
launched and that the run starts only when the owner runs PHASE E.
