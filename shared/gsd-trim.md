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
