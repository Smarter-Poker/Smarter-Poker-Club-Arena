#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# RAKE-AUDIT follow-up push (2026-07-24) — run on the Mac host:
#   bash ~/Documents/club-arena/DEPLOY-RAKE-AUDIT.sh
#
# PR #25 (merged from the cloud session) already deployed:
#   - server/src/services/supabase.ts        (BBJ re-arm: loadTable bbj_percent + pool auto-create)
#   - server/src/services/RakebackSettlerService.ts (exact-cents shares, weekly close, HWM guard)
#   - supabase/migrations/20260724*.sql      (both applied to the live DB already)
#
# This script commits + pushes the WORKING-TREE files that were too large for
# the cloud bridge, which contain the remaining critical fixes:
#   - server/src/engine/ServerTableEngine.ts (STOP RAKING TOURNAMENT POTS — 62,422
#     chips destroyed in 7d; BBJ default-enabled gates; dead RakebackEngine leak off)
#   - server/src/GameServer.ts               (tournament rake settled from ACTUAL
#     collected fees, not fee × entries incl. free horses; union audit CHECK fix)
#   - src/services/TournamentService.ts      (10% fee on rebuys/add-ons/re-entries,
#     fee ledger UUID fix, unregister fee reversal, 10% enforcement)
#   - src/services/SettlementService.ts, SettlementCronService.ts, BBJService.ts,
#     src/components/... BBJ display fixes, RAKE-BBJ-FULL-AUDIT-2026-07-24.md
#
# Pushing server/** to main auto-deploys the Hetzner engine (second deploy).
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

echo "== RAKE-AUDIT follow-up push =="
git add -A
git commit -m "RAKE-AUDIT sweep 2 follow-up to #25: tournament rake guard (STE), fee-ledger tournament settlement (GameServer), 10% fee on all tournament buy-ins, client BBJ/settlement fixes" || echo "(nothing to commit — already committed?)"

# PR #25 was merged remotely; identical-content files rebase cleanly.
git pull --rebase origin main
git push origin main

echo ""
echo "DONE. Push to main touching server/** triggers the Hetzner auto-deploy."
echo "Verify via Supabase (per CLAUDE.md): hand_history per-minute counts dip at"
echo "restart, then tournament hands show rake_amount = 0 (chip destruction fixed)."
