#!/usr/bin/env bash
# Installs bajzi/bin/cc-router.js and the six launchers (bajzi/bin/launchers/) into ~/.local/bin,
# after running the cc-router tests. An identical file is left untouched; a different one is kept
# as <name>.bak (one generation) before being replaced.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --test "$here"/tests/cc-router.test.js >/dev/null || { echo "cc-router tests FAILED - not installed" >&2; exit 1; }
bin="$HOME/.local/bin"
mkdir -p "$bin"
install_one() {  # $1 = source file, $2 = destination
  if [ -f "$2" ] && cmp -s "$1" "$2"; then echo "unchanged: $2"; return; fi
  [ -f "$2" ] && cp "$2" "$2.bak" && echo "backed up: $2.bak"
  cp "$1" "$2"
  echo "installed: $2"
}
install_one "$here/cc-router.js" "$bin/cc-router.js"
for f in worker glm ccr; do
  install_one "$here/launchers/$f" "$bin/$f"; chmod +x "$bin/$f"
  install_one "$here/launchers/$f.cmd" "$bin/$f.cmd"
done
