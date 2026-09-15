# GSD surface trimming — ready-made prompt

GSD's skills are **machine-wide**: they load in every session, even in repos where you never
use them. `.claude/METHODOLOGY` controls what the model USES, not what gets LOADED. Only this
operation gives tokens back.

**Measured on the VM (2026-09-01):** 71 skills ≈ 4,270 tok → 46 skills ≈ 2,913 tok. **Gain ~1,357.**

## What we keep and why

| Cluster | Keep? | Reason |
|---|---|---|
| `core_loop` | keep | the phase cycle itself |
| `utility` | keep | ship, debug, quick, config, progress, undo, map-codebase |
| `audit_review` | keep | code-review, verify-work, add-tests, secure-phase |
| `ai_eval` | **keep** | for AI products (IVR, call recording): AI-SPEC + eval-audit |
| `research_ideate` | disabled | superpowers `brainstorming`/`writing-plans` covers it |
| `workspace_state` | disabled | `/bajzi:handoff` is better than pause/resume-work |
| `milestone` | disabled | there is no milestone cycle |
| `ns_meta` | disabled | just menu skills on top of the concrete ones |
| `docs` | disabled | claude-md-management covers it |
| `ui` | disabled | only if you do not take UI work through a GSD phase |

## The prompt

```
Trim the GSD surface. GSD is machine-wide, so this gives tokens back in every repo.

1. BACK UP first:
   tar -czf ~/gsd-skills-backup-<date>.tgz -C ~/.claude skills commands agents .gsd-profile
   (On Windows, if there is no tar: copy the three directories under ~/.claude-gsd-backup-<date>.)

2. Write the ~/.claude/.gsd-surface.json file with EXACTLY this content:
   {
     "baseProfile": "full",
     "disabledClusters": ["research_ideate","workspace_state","milestone","ns_meta","docs","ui"],
     "explicitAdds": [],
     "explicitRemoves": []
   }

3. Work out which skills drop out. The cluster definitions:
   ~/.claude/gsd-core/bin/lib/clusters.cjs  (CLUSTERS export)
   IMPORTANT: a skill only drops out if it is in NO enabled cluster at all.
   (E.g. `health` is in both milestone AND utility -> it stays.)

4. Move — do NOT delete — the dropped ones here: ~/.claude/.gsd-surface-disabled/
   - skills/gsd-<name>/        -> .gsd-surface-disabled/skills/
   - commands/gsd-<name>.md    -> .gsd-surface-disabled/commands/
   Commands cost tokens too, moving only the skills is not enough.

5. Agents: from the `capabilities` map in ~/.claude/gsd-core/bin/lib/capability-registry.cjs
   move away only the agent whose capability lost ALL its skills, AND which no remaining
   capability uses. (On the VM this was 2 agents: gsd-ui-auditor, gsd-ui-checker.)

6. Verification: these MUST REMAIN under ~/.claude/skills —
   gsd-next, gsd-plan-phase, gsd-execute-phase, gsd-code-review, gsd-debug, gsd-ship,
   gsd-ai-integration-phase, gsd-eval-review, gsd-secure-phase, gsd-surface
   Report: how many skills/commands/agents remain, and the estimated always-on token cost
   (SKILL.md frontmatter length / 4).

WARNING: the documented path of the /gsd-surface skill (applySurface) is NOT runnable from
outside — resolveRuntimeArtifactLayout is not exported, and the gsd-tools CLI has no `surface`
subcommand either. That is why the manual move is needed. The state file is in the form GSD
expects, so /gsd-surface enable <cluster> can later work its own way.
```

## Restoring

Everything back: move the contents of `.gsd-surface-disabled/` back into place, and delete
`.gsd-surface.json`. On the VM there is the `~/.local/bin/gsd-surface-restore` script for this.
One cluster back: `/gsd-surface enable <cluster>`.

---

## 1.14.0 update (2026-09-15) — what changed, and what the old prompt gets wrong

Updated with `npx @opengsd/gsd-core@latest -g --claude`. Result: **9 skills (~248 tok) +
46 commands (~1,264 tok) ≈ 1,512 always-on**, against ~1,463 at 1.12.0. The +49 is one new
skill (`gsd-quick-batch`, utility cluster, skill-only — it has no slash command, so it stays).

### 1. The surface file now has a hard schema requirement
`readSurface()` returns null unless **all four** keys are present — `baseProfile`,
`disabledClusters`, `explicitAdds`, `explicitRemoves`. A file missing the two empty arrays is
**silently ignored** and you get all 72 skills back. Ours already had all four, so the trim
survived the update untouched. Check this BEFORE every update.

### 2. Surface beats --profile
`bin/install.js` reads the surface file and, when valid, replaces the resolved profile with it.
So `.gsd-surface.json` wins over both `--profile=` and the `.gsd-profile` marker. Note the
marker on this machine says `core` while the surface produces 46 — if the surface file is ever
deleted, the next update silently drops to core's 15 skills, which does NOT include next, debug,
ship, secure-phase, eval-review or ai-integration-phase.

### 3. `--profile=core,audit` from the help text is a trap
Valid profile names are exactly **core (15), standard (23), full (72)**. Unknown tokens are
dropped silently: `--profile=core,audit` resolves to core, and `--profile=audit` alone falls
back to **full**.

### 4. The real cost surprise: skills and commands duplicate each other
1.12 left 8 skill dirs + 46 commands. 1.14 installed **46 skill dirs**, 45 of which have the
same name as a command already on disk — roughly +1,110 always-on tokens for no new capability.
Fix, and the rule from now on: a GSD skill dir is only kept when it has **no** slash-command
counterpart. Everything else moves to `.gsd-surface-disabled/skills/` (move, never delete).
Kept here: the 8 from 1.12 plus `gsd-quick-batch`.

### 5. It deletes your own permissions.deny
1.14 removes the `Read(.env)`, `Read(.env.*)`, `Read(.secrets)` deny block that 1.12 wrote and
replaces it with a `PreToolUse` hook (`gsd-secret-read-guard.js`). Those rules are also OURS —
they are in `settings_merge` in the setup manifest. Restore them after every GSD update.

### 6. Hook timeouts went 5s -> 120s
Seven GSD hooks now carry a 120-second timeout (prompt-guard, workflow-guard,
worktree-path-guard, agent-isolation-guard, write-guard, validate-commit, secret-read-guard).
Worst case a blocked tool call stalls for two minutes instead of five seconds. Left as-is: the
installer owns these entries and hand-edits are reverted by the next update. If it ever bites,
that is the first thing to look at.

### 7. "Local patches detected" may be inert
The installer reported `hooks/gsd-node-runner.sh` as a local patch from 1.12 and offered
`/gsd-update --reapply`. On this machine `settings.json` references it **zero** times (hooks
resolve node directly), so the reapply was skipped deliberately. Check with
`grep -c gsd-node-runner ~/.claude/settings.json` before reapplying anything.

### 8. The agent layer — the cost the first pass missed (2026-09-15)

1.14 also stages **29 agent files** into `~/.claude/agents/`, worth **~1,648 always-on tokens**
(agent descriptions sit in the Agent tool listing every session). At 1.12 there were **zero**
agent files on this machine — which also means every GSD command that dispatches an agent
(`/gsd-code-review` → `gsd-code-reviewer`, `/gsd-debug` → `gsd-debug-session-manager`, …) was
spawning something that did not exist. The old low number was partly a broken install, not a
clean one.

Attribution check (skill bodies, dispatch sites only — the agent catalogs
`references/agent-contracts.md` and `references/model-profiles.md` list all 29 and cause false
positives): 26 of the 29 are dispatched by KEPT commands. Only the `ui` cluster's three are not.

**Moved away (3, ~141 tok):** `gsd-ui-auditor`, `gsd-ui-checker`, `gsd-ui-researcher`.
Note `gsd-ui-researcher` is MISSING from the `ui` capability in `capability-registry.cjs`
although `workflows/ui-phase.md` dispatches it — skill-body evidence wins over the registry.

**DECISION (owner, 2026-09-15): keep the other 26.** Cutting them saves at most ~910 more
tokens and breaks code-review, debug, ship's mempalace step, secure-phase, eval-review,
ai-integration-phase, validate-phase, audit-milestone and profile-user.

**Final surface on all three machines:** 9 skills (~248) + 46 commands (~1,264) + 26 agents
(~1,507) ≈ **3,019 always-on tokens**.

### 9. Pitfall resolved upstream
The "⚠ stale hooks — run /gsd-update" statusline loop is FIXED in 1.14.0:
`hooks/gsd-node-runner.sh` now carries `# gsd-hook-version: 1.14.0`, the line the checker
looks for. The old manual patch procedure is no longer needed.

### 10. Commands do not depend on the skill dirs
Verified before trimming: 42 of 46 command files pull their workflow from
`gsd-core/workflows/*.md`, only one references a skill dir. Moving a duplicate skill dir aside
therefore costs no functionality — the slash command carries the whole workflow.
