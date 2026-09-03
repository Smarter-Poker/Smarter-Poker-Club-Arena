#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# POST-MIGRATION CLEANUP — Verify + Commit + Build + Deploy
# ═══════════════════════════════════════════════════════════════════════════════
#
# What was cleaned up:
# 1. RakeWaterfallEngine import removed from TablePage.tsx (dead import, 0 callsites)
# 2. straddleEngine removed from StraddleToggle.tsx (replaced with onToggle callback)
# 3. flashPoolEngine removed from FlashPoolPage.tsx (replaced with Supabase RPC)
# 4. rakebackEngine removed from RakeService.ts + FinancialCronService.ts (replaced with DB RPC)
# 5. timeBankEngine removed from TablePage.tsx (8 callsites → GameServerAPI + local state)
# 6. 24 stale [MIGRATION STEP 1] comment markers cleaned from TablePage.tsx
#
# Remaining (safe): type-only imports in HydraService, BBJService, HandPersistenceService, SpinItWheel
# Deferred (admin-only): orchestrator imports in EngineDashboard.tsx

CLUB_ARENA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORLD_HUB_ROOT="$HOME/Documents/Smarter-Poker-World-Hub"

cd "$CLUB_ARENA_ROOT"

echo "═══════════════════════════════════════════════════"
echo "PHASE 1: TypeScript Check"
echo "═══════════════════════════════════════════════════"
npx tsc --noEmit
if [ $? -ne 0 ]; then
  echo "❌ TypeScript errors found — FIX BEFORE PROCEEDING"
  exit 1
fi
echo "✅ TypeScript: zero errors"

echo ""
echo "═══════════════════════════════════════════════════"
echo "PHASE 2: Grep Verification"
echo "═══════════════════════════════════════════════════"

# Check zero runtime engine imports in gameplay code
RUNTIME_IMPORTS=$(grep -rn "from ['\"].*engine/" src/pages/TablePage.tsx src/pages/FlashPoolPage.tsx src/components/table/StraddleToggle.tsx src/services/RakeService.ts src/services/FinancialCronService.ts 2>/dev/null | grep -v "import type" | grep -v "// \[MIGRATION\]" || true)
if [ -n "$RUNTIME_IMPORTS" ]; then
  echo "❌ Runtime engine imports still found:"
  echo "$RUNTIME_IMPORTS"
  exit 1
fi
echo "✅ Zero runtime engine imports in gameplay code"

echo ""
echo "═══════════════════════════════════════════════════"
echo "PHASE 3: Git Commit + Push Club Arena"
echo "═══════════════════════════════════════════════════"
git add -A
git commit -m "fix: remove all deferred client-side engine imports — server-authoritative cleanup

Removed 6 client engine runtime imports deferred from migration Steps 1-7:
- timeBankEngine (8 callsites) → GameServerAPI + DB state
- straddleEngine (1 callsite) → parent onToggle callback
- flashPoolEngine (1 callsite) → Supabase RPC
- rakebackEngine (4 callsites across 2 files) → DB RPC
- RakeWaterfallEngine (dead import, 0 callsites)
- 24 stale migration comment markers cleaned

Zero runtime engine imports remain in player-facing code.
Type-only imports (4 files) verified safe — erased at compile time."
git push origin main
echo "✅ Club Arena pushed"

echo ""
echo "═══════════════════════════════════════════════════"
echo "PHASE 4: Vite Build"
echo "═══════════════════════════════════════════════════"
npm run build
echo "✅ Vite build complete"

echo ""
echo "═══════════════════════════════════════════════════"
echo "PHASE 5: Sync to World Hub"
echo "═══════════════════════════════════════════════════"
if [ -d "$WORLD_HUB_ROOT" ]; then
  bash scripts/sync-to-world-hub.sh "$WORLD_HUB_ROOT"
  echo "✅ Synced to World Hub"

  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "PHASE 6: Push World Hub"
  echo "═══════════════════════════════════════════════════"
  cd "$WORLD_HUB_ROOT"
  bash scripts/git-safe-push.sh "chore: update Club Arena — post-migration engine cleanup"
  echo "✅ World Hub pushed — Vercel auto-deploying smarter.poker"
else
  echo "⚠️ World Hub not found at $WORLD_HUB_ROOT — skipping sync/deploy"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ POST-MIGRATION CLEANUP COMPLETE"
echo "═══════════════════════════════════════════════════"
