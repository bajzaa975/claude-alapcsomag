# GSD felszín-szűkítés — kész prompt

A GSD skilljei **gépszintűek**: minden sessionben betöltődnek, akkor is, ha abban a repóban
soha nem használod őket. A `.claude/METHODOLOGY` azt szabályozza, mit HASZNÁL a modell, nem
azt, mi TÖLTŐDIK BE. Tokent csak ez a művelet ad vissza.

**Mérés a VM-en (2026-09-01):** 71 skill ≈ 4 270 tok → 46 skill ≈ 2 913 tok. **Nyereség ~1 357.**

## Mit hagyunk meg és miért

| Klaszter | Marad? | Indok |
|---|---|---|
| `core_loop` | marad | maga a fázis-ciklus |
| `utility` | marad | ship, debug, quick, config, progress, undo, map-codebase |
| `audit_review` | marad | code-review, verify-work, add-tests, secure-phase |
| `ai_eval` | **marad** | AI-termékekhez (IVR, hangrögzítés): AI-SPEC + eval-audit |
| `research_ideate` | tiltva | a superpowers `brainstorming`/`writing-plans` lefedi |
| `workspace_state` | tiltva | a `/bajzi:handoff` jobb, mint a pause/resume-work |
| `milestone` | tiltva | nincs milestone-ciklus |
| `ns_meta` | tiltva | csak menü-skillek a konkrétak fölé |
| `docs` | tiltva | a claude-md-management fedi |
| `ui` | tiltva | csak ha a UI-t nem viszed GSD-fázisban |

## A prompt

```
Szűkítsd a GSD felszínét. A GSD gépszintű, ezért ez minden repóban visszaad tokent.

1. MENTÉS először:
   tar -czf ~/gsd-skills-backup-<dátum>.tgz -C ~/.claude skills commands agents .gsd-profile
   (Windowson, ha nincs tar: másold a három mappát ~/.claude-gsd-backup-<dátum> alá.)

2. Írd meg a ~/.claude/.gsd-surface.json fájlt PONTOSAN ezzel a tartalommal:
   {
     "baseProfile": "full",
     "disabledClusters": ["research_ideate","workspace_state","milestone","ns_meta","docs","ui"],
     "explicitAdds": [],
     "explicitRemoves": []
   }

3. Számold ki, mely skillek esnek ki. A klaszter-definíciók:
   ~/.claude/gsd-core/bin/lib/clusters.cjs  (CLUSTERS export)
   FONTOS: egy skill csak akkor esik ki, ha EGYETLEN engedélyezett klaszterben sincs benne.
   (Pl. a `health` a milestone-ban ÉS a utility-ban is szerepel -> marad.)

4. Helyezd át — NE töröld — a kiesőket ide: ~/.claude/.gsd-surface-disabled/
   - skills/gsd-<név>/        -> .gsd-surface-disabled/skills/
   - commands/gsd-<név>.md    -> .gsd-surface-disabled/commands/
   A parancsok is költenek, nem elég a skilleket elvinni.

5. Agentek: a ~/.claude/gsd-core/bin/lib/capability-registry.cjs `capabilities` mapjából
   csak azt az agentet vidd el, amelynek a capability-je MINDEN skillje kiesett, ÉS amit
   egyetlen megmaradó capability sem használ. (A VM-en ez 2 agent volt: gsd-ui-auditor,
   gsd-ui-checker.)

6. Ellenőrzés: ezek MARADJANAK meg a ~/.claude/skills alatt —
   gsd-next, gsd-plan-phase, gsd-execute-phase, gsd-code-review, gsd-debug, gsd-ship,
   gsd-ai-integration-phase, gsd-eval-review, gsd-secure-phase, gsd-surface
   Írd ki: hány skill/command/agent maradt, és a becsült always-on tokenköltség
   (a SKILL.md frontmatter hossza / 4).

FIGYELEM: a /gsd-surface skill dokumentált útja (applySurface) NEM futtatható kívülről —
a resolveRuntimeArtifactLayout nincs exportálva, és a gsd-tools CLI-nek sincs `surface`
alparancsa. Ezért kell a kézi áthelyezés. Az állapotfájl a GSD által elvárt formában van,
tehát a /gsd-surface enable <klaszter> később a saját útján tud dolgozni.
```

## Visszaállítás

Mindent vissza: a `.gsd-surface-disabled/` tartalmát vissza a helyére, és törölni a
`.gsd-surface.json`-t. A VM-en erre a `~/.local/bin/gsd-surface-restore` script van.
Egy klasztert vissza: `/gsd-surface enable <klaszter>`.
