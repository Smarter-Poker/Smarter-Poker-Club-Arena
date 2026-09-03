#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# STEP 5 DEPLOY — PORT SUPPORTING: TimeBankEngine, DisconnectEngine, PreActionEngine, AtomicStackService
# ═══════════════════════════════════════════════════════════════════════════════
# Run from Club Arena root: bash scripts/step5-deploy.sh
# Requires: ~/Documents/Smarter-Poker-World-Hub exists

set -e
CLUB_ARENA="$(cd "$(dirname "$0")/.." && pwd)"
WORLD_HUB="$HOME/Documents/Smarter-Poker-World-Hub"

echo "═══════════════════════════════════════════════════════════"
echo "STEP 5 DEPLOY — PORT SUPPORTING"
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
for f in TimeBankEngine.ts DisconnectEngine.ts PreActionEngine.ts AtomicStackService.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# ── Phase 2b: Verify Step 4 files still present ──
echo ""
echo "▶ Phase 2b: Verify Step 4 files still present..."
for f in PreciseActionTimer.ts ServerActionValidator.ts StateVerifier.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f (Step 4 file)"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# ── Phase 2c: Verify integrations in ServerTableEngine ──
echo ""
echo "▶ Phase 2c: Verify integrations in ServerTableEngine..."
for pattern in "TimeBankEngine" "DisconnectEngine" "PreActionEngine" "AtomicStackService" "timeBankEngine" "disconnectEngine" "preActionEngine" "atomicStackService"; do
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
for f in TimeBankEngine.js DisconnectEngine.js PreActionEngine.js AtomicStackService.js; do
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
git commit -m "feat(step5): port supporting modules — TimeBankEngine, DisconnectEngine, PreActionEngine, AtomicStackService

Step 5 of server-authoritative migration:
- TimeBankEngine: pool-based time bank with auto-activate and orbit refill
- DisconnectEngine: heartbeat disconnect detection with auto-fold/check
- PreActionEngine: queued pre-actions (auto-fold, auto-check/fold, auto-call)
- AtomicStackService: versioned optimistic locking for race-proof stack mutations
- Integrated all 4 into ServerTableEngine with full lifecycle hooks"
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
git commit -m "chore: update Club Arena — Step 5 supporting modules ported (timebank, disconnect, preaction, atomic stacks)"
git push origin main
echo "✅ World Hub pushed — Vercel will auto-deploy to smarter.poker"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ STEP 5 DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "New server engine files:"
echo "  server/src/engine/TimeBankEngine.ts (~280 lines)"
echo "  server/src/engine/DisconnectEngine.ts (~310 lines)"
echo "  server/src/engine/PreActionEngine.ts (~270 lines)"
echo "  server/src/engine/AtomicStackService.ts (~240 lines)"
echo ""
echo "Verify live at: https://smarter.poker/hub/club-arena/"
