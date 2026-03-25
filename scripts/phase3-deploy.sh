#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3 DEPLOY — Premium UI/UX Overhaul (Bible V8 Compliance)
# ═══════════════════════════════════════════════════════════════════════════════
# Run from Club Arena root: bash scripts/phase3-deploy.sh
# Requires: ~/Documents/Smarter-Poker-World-Hub exists

set -e
CLUB_ARENA="$(cd "$(dirname "$0")/.." && pwd)"
WORLD_HUB="$HOME/Documents/Smarter-Poker-World-Hub"

echo "═══════════════════════════════════════════════════════════"
echo "PHASE 3 DEPLOY — Premium UI/UX Overhaul"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: TypeScript Check (Client) ──
echo "▶ Phase 1: TypeScript check (client)..."
cd "$CLUB_ARENA"
npx tsc --noEmit
echo "✅ Client TypeScript: PASS"

# ── Phase 1b: TypeScript Check (Server) ──
echo ""
echo "▶ Phase 1b: TypeScript check (server)..."
cd "$CLUB_ARENA/server"
npx tsc --noEmit
echo "✅ Server TypeScript: PASS"

# ── Phase 2: Verify Phase 3 changes ──
echo ""
echo "▶ Phase 2: Verify Phase 3 changes..."

# Check new files exist
for f in hooks/useActionSequencer.ts; do
  if [ ! -f "$CLUB_ARENA/src/$f" ]; then
    echo "❌ MISSING: src/$f"
    exit 1
  fi
  echo "  ✅ src/$f"
done

# Check modified files contain expected patterns
for pattern in "hapticEnabled" "tableTheme" "TABLE_THEMES"; do
  COUNT=$(grep -c "$pattern" "$CLUB_ARENA/src/components/table/SettingsPanel.tsx" || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "❌ MISSING: $pattern not found in SettingsPanel.tsx"
    exit 1
  fi
  echo "  ✅ SettingsPanel: $pattern ($COUNT refs)"
done

for pattern in "isHapticEnabled" "vibrationsEnabled"; do
  COUNT=$(grep -c "$pattern" "$CLUB_ARENA/src/hooks/useTableSettings.ts" || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "❌ MISSING: $pattern not found in useTableSettings.ts"
    exit 1
  fi
  echo "  ✅ useTableSettings: $pattern ($COUNT refs)"
done

for pattern in "playCommunityCard" "playShowdown" "triggerChipAnimationRef"; do
  COUNT=$(grep -c "$pattern" "$CLUB_ARENA/src/pages/TablePage.tsx" || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "❌ MISSING: $pattern not found in TablePage.tsx"
    exit 1
  fi
  echo "  ✅ TablePage: $pattern ($COUNT refs)"
done

echo "✅ Phase 3 changes verified"

# ── Phase 3: Git commit + push Club Arena ──
echo ""
echo "▶ Phase 3: Git commit + push Club Arena..."
cd "$CLUB_ARENA"
git add -A
git commit -m "feat(phase3): Premium UI/UX overhaul — Bible V8 compliance

Phase 3 of post-migration premium upgrade:
- SettingsPanel: Add table theme selector (7 themes from design-tokens.css)
- SettingsPanel: Add haptic feedback toggle (syncs to HapticService)
- useTableSettings: Add isHapticEnabled with vibrationsEnabled localStorage sync
- TablePage: Wire playCommunityCard() + playShowdown() sounds on board stage transitions
- TablePage: Sequential animation timing per Bible V8 §5.2 (action label → chips → pot → turn)
- TablePage: Action labels + chip animations from server PLAYER_ACTION broadcasts
- TablePage: All-in runout detection from server state (dramatic mode for all-in boards)
- CSS: Slower card animations in all-in mode (turn 1.0s, river 1.3s vs normal 0.55s/0.65s)
- SoundService: playRaise() volume scales with bet size (logarithmic, Bible §5.3)
- SoundService: New playDisconnect() method (descending tone, Bible §5.3)
- New useActionSequencer hook for Bible V8 §5.2 compliant animation sequencing"
git push origin main
echo "✅ Club Arena pushed"

# ── Phase 4: Vite build ──
echo ""
echo "▶ Phase 4: Vite build..."
cd "$CLUB_ARENA"
npm run build
echo "✅ Vite build complete"

# ── Phase 5: Sync to World Hub ──
echo ""
echo "▶ Phase 5: Sync to World Hub..."
if [ ! -d "$WORLD_HUB" ]; then
  echo "❌ World Hub not found at $WORLD_HUB"
  exit 1
fi

rm -rf "$WORLD_HUB/public/hub/club-arena/assets"
cp -r "$CLUB_ARENA/dist/"* "$WORLD_HUB/public/hub/club-arena/"
find "$WORLD_HUB/public/hub/club-arena" -name "*.map" -delete
echo "✅ Synced to World Hub"

# ── Phase 6: Push World Hub ──
echo ""
echo "▶ Phase 6: Push World Hub..."
cd "$WORLD_HUB"
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  No World Hub diff"
  git push origin main 2>/dev/null || echo "ℹ️  Already up to date"
else
  git commit -m "chore: update Club Arena — Phase 3 Premium UI/UX overhaul (themes, haptics, sounds, animations)"
  git push origin main
fi
echo "✅ World Hub in sync"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ PHASE 3 DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Changes deployed:"
echo "  • Theme selector (7 themes) in table settings"
echo "  • Haptic toggle in table settings"
echo "  • Community card + showdown sounds wired"
echo "  • Sequential animation timing (Bible V8 §5.2)"
echo "  • Action labels from server broadcasts"
echo "  • All-in runout dramatic slowdown"
echo "  • playRaise() volume scaling"
echo "  • playDisconnect() sound added"
echo ""
echo "Verify live at: https://smarter.poker/hub/club-arena/"
