#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# STEP 7 DEPLOY — PORT TOURNAMENT & EXTRAS: ChipRace, TableBalancer, TableBreak, OFC, Telemetry
# ═══════════════════════════════════════════════════════════════════════════════
# Run from Club Arena root: bash scripts/step7-deploy.sh
# Requires: ~/Documents/Smarter-Poker-World-Hub exists

set -e
CLUB_ARENA="$(cd "$(dirname "$0")/.." && pwd)"
WORLD_HUB="$HOME/Documents/Smarter-Poker-World-Hub"

echo "═══════════════════════════════════════════════════════════"
echo "STEP 7 DEPLOY — PORT TOURNAMENT & EXTRAS (FINAL STEP)"
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

# ── Phase 2: Verify new Step 7 files exist ──
echo ""
echo "▶ Phase 2: Verify new Step 7 server engine files..."
for f in ChipRaceEngine.ts TableBalancer.ts TableBreakEngine.ts OFCPineappleEngine.ts OFCDealingOrchestrator.ts EngineTelemetry.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# ── Phase 2b: Verify Step 4+5+6 files still present ──
echo ""
echo "▶ Phase 2b: Verify Step 4+5+6 files still present..."
for f in PreciseActionTimer.ts ServerActionValidator.ts StateVerifier.ts TimeBankEngine.ts DisconnectEngine.ts PreActionEngine.ts AtomicStackService.ts CryptoRandom.ts MonteCarloEquity.ts StraddleEngine.ts MixedGameEngine.ts RunItTwiceEngine.ts InsuranceEngine.ts RakebackEngine.ts; do
  if [ ! -f "$CLUB_ARENA/server/src/engine/$f" ]; then
    echo "❌ MISSING: server/src/engine/$f (Step 4/5/6 file)"
    exit 1
  fi
  echo "  ✅ server/src/engine/$f"
done

# ── Phase 2c: Verify integrations in ServerTableEngine ──
echo ""
echo "▶ Phase 2c: Verify Step 7 integrations in ServerTableEngine..."
for pattern in "ChipRaceEngine" "TableBalancer" "TableBreakEngine" "OFCDealingOrchestrator" "EngineTelemetry" "chipRaceEngine" "tableBalancer" "tableBreakEngine" "ofcOrchestrator" "engineTelemetry"; do
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
for f in ChipRaceEngine.js TableBalancer.js TableBreakEngine.js OFCPineappleEngine.js OFCDealingOrchestrator.js EngineTelemetry.js; do
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
git commit -m "feat(step7): port tournament & extras — ChipRace, TableBalancer, TableBreak, OFC, Telemetry

Step 7 of server-authoritative migration (FINAL STEP):
- ChipRaceEngine: tournament chip denomination removal with lottery
- TableBalancer: MTT table balancing optimizer (sum-of-squared-deviations)
- TableBreakEngine: balanced player redistribution with seat lottery
- OFCPineappleEngine: full Open Face Chinese Pineapple game logic (pure)
- OFCDealingOrchestrator: OFC dealing flow with placement timers
- EngineTelemetry: production observability (hands/hour, timers, cache)
- Integrated all 6 into ServerTableEngine with lifecycle hooks

ALL 7 MIGRATION STEPS COMPLETE — server-authoritative migration finished."
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

# ── Phase 7: Push World Hub (may be no diff — Step 7 is server-only) ──
echo ""
echo "▶ Phase 7: Push World Hub..."
cd "$WORLD_HUB"
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  No World Hub diff (expected — Step 7 is server-only TypeScript)"
  git push origin main 2>/dev/null || echo "ℹ️  Already up to date"
else
  git commit -m "chore: update Club Arena — Step 7 tournament & extras ported (ChipRace, TableBalancer, OFC, Telemetry)"
  git push origin main
fi
echo "✅ World Hub in sync"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ STEP 7 DEPLOY COMPLETE — ALL MIGRATION STEPS FINISHED"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "New server engine files (6):"
echo "  server/src/engine/ChipRaceEngine.ts (~145 lines)"
echo "  server/src/engine/TableBalancer.ts (~210 lines)"
echo "  server/src/engine/TableBreakEngine.ts (~260 lines)"
echo "  server/src/engine/OFCPineappleEngine.ts (~530 lines)"
echo "  server/src/engine/OFCDealingOrchestrator.ts (~300 lines)"
echo "  server/src/engine/EngineTelemetry.ts (~245 lines)"
echo ""
echo "🎉 SERVER-AUTHORITATIVE MIGRATION COMPLETE 🎉"
echo "All 7 steps done. 22 new server engine files total."
echo ""
echo "Verify live at: https://smarter.poker/hub/club-arena/"
