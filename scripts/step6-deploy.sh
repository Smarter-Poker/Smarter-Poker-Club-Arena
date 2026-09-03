#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# STEP 6 DEPLOY — PORT ADVANCED: Straddle, RIT, Insurance, MixedGame, Rakeback
# ═══════════════════════════════════════════════════════════════════════════════
# Run from Club Arena root: bash scripts/step6-deploy.sh
# Requires: ~/Documents/Smarter-Poker-World-Hub exists

set -e
CLUB_ARENA="$(cd "$(dirname "$0")/.." && pwd)"
WORLD_HUB="$HOME/Documents/Smarter-Poker-World-Hub"

echo "═══════════════════════════════════════════════════════════"
echo "STEP 6 DEPLOY — PORT ADVANCED"
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
for f in CryptoRandom.ts MonteCarloEquity.ts StraddleEngine.ts MixedGameEngine.ts RunItTwiceEngine.ts InsuranceEngine.ts RakebackEngine.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# ── Phase 2b: Verify Step 4+5 files still present ──
echo ""
echo "▶ Phase 2b: Verify Step 4+5 files still present..."
for f in PreciseActionTimer.ts ServerActionValidator.ts StateVerifier.ts TimeBankEngine.ts DisconnectEngine.ts PreActionEngine.ts AtomicStackService.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f (Step 4/5 file)"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# ── Phase 2c: Verify integrations in ServerTableEngine ──
echo ""
echo "▶ Phase 2c: Verify integrations in ServerTableEngine..."
for pattern in "StraddleEngine" "MixedGameEngine" "RunItTwiceEngine" "InsuranceEngine" "RakebackEngine" "straddleEngine" "mixedGameEngine" "runItTwiceEngine" "insuranceEngine" "rakebackEngine"; do
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
for f in CryptoRandom.js MonteCarloEquity.js StraddleEngine.js MixedGameEngine.js RunItTwiceEngine.js InsuranceEngine.js RakebackEngine.js; do
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
git commit -m "feat(step6): port advanced modules — Straddle, RIT, Insurance, MixedGame, Rakeback

Step 6 of server-authoritative migration:
- CryptoRandom: cryptographic RNG (dependency for MonteCarloEquity)
- MonteCarloEquity: equity calculator for insurance premiums
- StraddleEngine: UTG/Mississippi straddles with auto-enrollment
- MixedGameEngine: HORSE and custom variant rotation
- RunItTwiceEngine: dual-board dealing for all-in scenarios
- InsuranceEngine: all-in equity insurance with premium calculation
- RakebackEngine: weighted contributed rake tracking with tier system
- Integrated all 7 into ServerTableEngine with full lifecycle hooks"
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

rm -rf "$WORLD_HUB/public/hub/club-arena/assets"
cp -r "$CLUB_ARENA/dist/"* "$WORLD_HUB/public/hub/club-arena/"
find "$WORLD_HUB/public/hub/club-arena" -name "*.map" -delete
echo "✅ Synced to World Hub"

# ── Phase 7: Push World Hub (may be no diff — Step 6 is server-only) ──
echo ""
echo "▶ Phase 7: Push World Hub..."
cd "$WORLD_HUB"
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  No World Hub diff (expected — Step 6 is server-only TypeScript)"
  git push origin main 2>/dev/null || echo "ℹ️  Already up to date"
else
  git commit -m "chore: update Club Arena — Step 6 advanced modules ported (straddle, RIT, insurance, mixed game, rakeback)"
  git push origin main
fi
echo "✅ World Hub in sync"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ STEP 6 DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "New server engine files (7 + 1 dependency):"
echo "  server/src/engine/CryptoRandom.ts (93 lines)"
echo "  server/src/engine/MonteCarloEquity.ts (122 lines)"
echo "  server/src/engine/StraddleEngine.ts (~240 lines)"
echo "  server/src/engine/MixedGameEngine.ts (~210 lines)"
echo "  server/src/engine/RunItTwiceEngine.ts (~290 lines)"
echo "  server/src/engine/InsuranceEngine.ts (~275 lines)"
echo "  server/src/engine/RakebackEngine.ts (~290 lines)"
echo ""
echo "Verify live at: https://smarter.poker/hub/club-arena/"
