#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Sync Club Arena dist/ to World Hub public/hub/club-arena/
# ═══════════════════════════════════════════════════════════════════════════════
#
#  Run this after making changes to Club Arena source code.
#  It builds the SPA, strips source maps, and copies everything to the
#  World Hub's public/ directory for native serving from smarter.poker.
#
#  Usage:
#    bash scripts/sync-to-world-hub.sh [path-to-world-hub]
#
#  Default World Hub path: ../Smarter-Poker-World-Hub
# ═══════════════════════════════════════════════════════════════════════════════

set -e

WORLD_HUB="${1:-../Smarter-Poker-World-Hub}"

if [ ! -d "$WORLD_HUB" ]; then
  echo "ERROR: World Hub not found at $WORLD_HUB"
  echo "Usage: bash scripts/sync-to-world-hub.sh [path-to-world-hub]"
  exit 1
fi

echo ""
echo "=== Step 1: Safety checks ==="
bash scripts/build-and-verify.sh
echo ""

echo "=== Step 2: Strip source maps ==="
find dist -name "*.map" -delete
echo "  Removed all .map files"
echo ""

echo "=== Step 3: Sync to World Hub ==="
TARGET="$WORLD_HUB/public/hub/club-arena"
rm -rf "$TARGET"
cp -r dist/ "$TARGET/"
FILE_COUNT=$(find "$TARGET" -type f | wc -l)
SIZE=$(du -sh "$TARGET" | cut -f1)
echo "  Copied $FILE_COUNT files ($SIZE) to $TARGET"
echo ""

echo "=== Step 4: Verify ==="
if [ -f "$TARGET/index.html" ] && [ -d "$TARGET/assets" ]; then
  echo "  index.html: present"
  echo "  assets/: present ($(ls "$TARGET/assets/"*.js | wc -l) JS files)"
  echo "  cards/: $([ -d "$TARGET/cards" ] && echo "present" || echo "missing")"
  echo "  images/: $([ -d "$TARGET/images" ] && echo "present" || echo "missing")"
  echo ""
  echo "=== SYNC COMPLETE ==="
  echo ""
  echo "  Next steps:"
  echo "    cd $WORLD_HUB"
  echo "    git add public/hub/club-arena/"
  echo "    git commit -m 'chore: update Club Arena dist'"
  echo "    git push origin main"
  echo ""
else
  echo "  ERROR: Sync failed — missing files in $TARGET"
  exit 1
fi
