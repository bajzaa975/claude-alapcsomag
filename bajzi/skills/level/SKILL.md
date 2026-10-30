---
name: level
description: Owner-only saver level command, handled by a hook: /bajzi:level [0-3|L0-L3|claude|light|glm|tight] [session|repo|global] | unset [scope]; no argument = status.
argument-hint: "[<0-3|claude|light|glm|tight> [session|repo|global]] | unset [session|repo|global]"
disable-model-invocation: true
---

Fallback only: the bajzi level hook did not handle this command. Do NOT change the level yourself.

Tell the owner in one line: type `! worker --level <n>` (this session) or `! worker --level <n> --global` (machine default); a repo default (`/bajzi:level <n> repo`) needs the bajzi hooks enabled.
