#!/usr/bin/env bash
# Installs bajzi/bin/cc-router.js over ~/.local/bin/cc-router.js after running its tests.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --test "$here"/tests/*.test.js >/dev/null || { echo "cc-router tests FAILED - not installed" >&2; exit 1; }
dst="$HOME/.local/bin/cc-router.js"
[ -f "$dst" ] && cp "$dst" "$dst.bak"
cp "$here/cc-router.js" "$dst"
echo "installed: $dst (previous copy: $dst.bak)"
