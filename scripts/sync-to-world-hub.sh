#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# DEPRECATED — use ~/Documents/Smarter-Poker-World-Hub/scripts/sync-club-arena.sh
# ═══════════════════════════════════════════════════════════════════════════════
# This script is kept as a thin shim so existing muscle memory keeps working.
# The canonical deploy path (Phase U5.4) is the WH-side script, which:
#   - uploads Sentry sourcemaps (silent-no-op slug bug fixed in task #133)
#   - stages + commits + pushes WH in one atomic operation
#
# TO BE REMOVED after U6 doc sweep once all docs point at the WH script.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

WH="${1:-$HOME/Documents/Smarter-Poker-World-Hub}"
CANONICAL="$WH/scripts/sync-club-arena.sh"

if [ ! -f "$CANONICAL" ]; then
  echo "ERROR: Canonical script not found at $CANONICAL"
  echo "       Expected WH at: $WH"
  echo "       Pass WH path as first arg if it lives elsewhere."
  exit 1
fi

echo "⚠️  sync-to-world-hub.sh is deprecated. Forwarding to $CANONICAL..."
echo ""
exec bash "$CANONICAL"
