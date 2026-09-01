---
name: alapcsomag
description: Token-takarékos alapcsomag telepítése ebbe a projektbe — MCP-réteg (code-review-graph, token-savior), kontextus-őr hook és runtime/HANDOFF.md váz. Használd, ha a felhasználó azt mondja "alapcsomag", "állítsd be a projektet", "token-takarékos setup", vagy új repóban kezd dolgozni.
---

# Token-takarékos alapcsomag — projekt-réteg

Telepítsd ebbe a projektbe a token-takarékos alapcsomag projekt-rétegét. Minden lépés IDEMPOTENS
legyen: meglévő fájlt egészíts ki, ne írj felül; kész elemet hagyj békén. A végén tömör jelentés.

**Először állapítsd meg, milyen környezetben futsz** (van-e Bash tool, van-e repo-gyökér):
- **Claude Code** (Bash + repo): az 1–5. lépés mind érvényes.
- **Cowork / Desktop** (nincs shell vagy nincs git-repo): az 1. és 4. lépést HAGYD KI —
  ott az MCP-connectorokat a plugin, illetve a Customize → Connectors kezeli, nem a repo
  `.mcp.json`-ja. A 2–3. és 5. lépés viszont ott is elvégzendő.

---

## 1. `.mcp.json` a repo gyökerébe

Ha van, egészítsd ki; a `<REPO>` = a `pwd` kimenete.
Előfeltétel: `uvx` (ha nincs: `curl -LsSf https://astral.sh/uv/install.sh | sh`).

```json
{
  "mcpServers": {
    "code-review-graph": {
      "command": "uvx",
      "args": ["--python", "3.13", "better-code-review-graph"],
      "type": "stdio"
    },
    "token-savior": {
      "command": "uvx",
      "args": ["--from", "token-savior-recall[memory-vector]", "--with", "mcp", "token-savior"],
      "env": {
        "TOKEN_SAVIOR_CLIENT": "claude-code",
        "TOKEN_SAVIOR_PROFILE": "optimized",
        "WORKSPACE_ROOTS": "<REPO>"
      },
      "type": "stdio"
    }
  }
}
```

## 2. Kontextus-őr hook — `.claude/settings.json` a repóban (meglévőbe merge-elve)

Ezt csak akkor kell külön beállítani, ha a `bajzi` plugin nincs telepítve (a plugin saját
SessionStart hookja ennél többet tud: a javasolt kezdő promptot is kiírja).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "cat runtime/HANDOFF.md 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

## 3. HANDOFF-váz

`runtime/HANDOFF.md` (ha nincs) + a `runtime/` kerüljön a `.gitignore`-ba, ha a csapat nem
akarja verziózni:

```markdown
# HANDOFF — session-folytatás
Frissítve: <dátum> · Feladat: <a session célja egy mondatban>
## Hol tartunk
## Kész
## KÖVETKEZŐ LÉPÉS (pontosan, ezzel kell kezdeni)
## Döntések / csapdák
## Érintett fájlok (path-ok)
## JAVASOLT KEZDŐ PROMPT
```

## 4. Környezet-ellenőrzés

`echo $ANTHROPIC_BASE_URL` — ha proxy/FCC van beállítva, a natív MCP tool search KIKAPCSOL
(minden séma előre betöltődik): jelezd, hogy ilyenkor batch-futásnál kötelező a
`--strict-mcp-config --mcp-config .mcp.json`, és kevés MCP-szerver legyen.

## 5. Verifikáció

A két MCP indul (`uvx … --help`); jelezd, hogy az MCP/hook változás a KÖVETKEZŐ
session-indításkor él; új sessionben `/context` bázis < 20%, `/mcp` hibátlan.
Tömör zárójelentés: mi készült, mi maradt kézire.
