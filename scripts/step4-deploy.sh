#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4 DEPLOY — PORT CORE: PreciseActionTimer, ServerActionValidator, StateVerifier
# ═══════════════════════════════════════════════════════════════════════════════
# Run from Club Arena root: bash scripts/step4-deploy.sh
# Requires: ~/Documents/Smarter-Poker-World-Hub exists

set -e
CLUB_ARENA="$(cd "$(dirname "$0")/.." && pwd)"
WORLD_HUB="$HOME/Documents/Smarter-Poker-World-Hub"

echo "═══════════════════════════════════════════════════════════"
echo "STEP 4 DEPLOY — PORT CORE"
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

# ── Phase 2: Verify new files exist ──
echo ""
echo "▶ Phase 2: Verify new server engine files..."
for f in PreciseActionTimer.ts ServerActionValidator.ts StateVerifier.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# Verify integration in ServerTableEngine
echo ""
echo "▶ Phase 2b: Verify integrations in ServerTableEngine..."
for pattern in "PreciseActionTimer" "ServerActionValidator" "StateVerifier" "preciseTimer" "actionValidator" "stateVerifier"; do
  COUNT=$(grep -c "$pattern" "$CLUB_ARENA/server/src/engine/ServerTableEngine.ts" || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "❌ MISSING: $pattern not found in ServerTableEngine.ts"
    exit 1
  fi
  echo "  ✅ $pattern: $COUNT references"
done

# ── Phase 3: Build server dist ──
echo ""
echo "▶ Phase 3: Rebuild server dist..."
cd "$CLUB_ARENA/server"
npx tsc
echo "✅ Server compiled to dist/"

# Verify compiled files
for f in PreciseActionTimer.js ServerActionValidator.js StateVerifier.js; do
  if [ ! -f "$CLUB_ARENA/server/dist/engine/$f" ]; then
    echo "❌ MISSING compiled: server/dist/engine/$f"
    exit 1
  fi
  echo "  ✅ server/dist/engine/$f"
done

# ── Phase 4: Git commit + push Club Arena ──
echo ""
echo "▶ Phase 4: Git commit + push Club Arena..."
cd "$CLUB_ARENA"
git add -A
git commit -m "feat(step4): port core modules — PreciseActionTimer, ServerActionValidator, StateVerifier

Step 4 of server-authoritative migration:
- PreciseActionTimer: deadline-based timers replacing setTimeout (immune to drift)
- ServerActionValidator: 12-error-code action validation (timing, duplicates, amounts)
- StateVerifier: 6-check game state integrity (chip conservation, no dupes, pot sanity)
- Integrated all 3 into ServerTableEngine with full lifecycle hooks"
git push origin main
echo "✅ Club Arena pushed"

# ── Phase 5: Vite build ──
echo ""
echo "▶ Phase 5: Vite build..."
cd "$CLUB_ARENA"
npm run build
echo "✅ Vite build complete"

# ── Phase 6: Sync to World Hub ──
echo ""
echo "▶ Phase 6: Sync to World Hub..."
if [ ! -d "$WORLD_HUB" ]; then
  echo "❌ World Hub not found at $WORLD_HUB"
  exit 1
fi

# Clean old files and copy new build
rm -rf "$WORLD_HUB/public/hub/club-arena/assets"
cp -r "$CLUB_ARENA/dist/"* "$WORLD_HUB/public/hub/club-arena/"
# Remove source maps from production
find "$WORLD_HUB/public/hub/club-arena" -name "*.map" -delete
echo "✅ Synced to World Hub"

# ── Phase 7: Push World Hub ──
echo ""
echo "▶ Phase 7: Push World Hub..."
cd "$WORLD_HUB"
git add -A
git commit -m "chore: update Club Arena — Step 4 core modules ported (timer, validator, verifier)"
git push origin main
echo "✅ World Hub pushed — Vercel will auto-deploy to smarter.poker"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ STEP 4 DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "New server engine files:"
echo "  server/src/engine/PreciseActionTimer.ts (261 lines)"
echo "  server/src/engine/ServerActionValidator.ts (278 lines)"
echo "  server/src/engine/StateVerifier.ts (263 lines)"
echo ""
echo "Verify live at: https://smarter.poker/hub/club-arena/"
