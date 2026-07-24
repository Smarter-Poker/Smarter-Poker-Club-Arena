#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# TOURNEY-AUDIT SWEEP 4 deploy (2026-07-24) — run on the Mac host:
#   bash ~/Documents/club-arena/DEPLOY-TOURNEY-SWEEP4.sh
# EXPLICIT staging only (never `git add -A`).
#
# SERVER (push auto-deploys the Hetzner engine):
#   server/src/GameServer.ts
#     - ALL cancel paths (restart-orphan SNG/Spin, >12h stale MTT) now share
#       one cleanup: refund real players (buy-in + fee + fee reversal), close
#       tournament_players rows, close tables — fixes the 64 fresh stranded
#       rows the sweep-3 restart-cancel path left behind, and the >12h MTT
#       cancel that NEVER refunded anyone (the promised "separate cleanup"
#       never existed)
#     - waitForHandComplete was a NO-OP (queried hand_history ended_at IS NULL,
#       which never matches — rows are inserted at completion): table breaks
#       and rebalances ALWAYS proceeded mid-hand. Now checks
#       hand_state_snapshots and SKIPS unsafe moves instead of forcing them
#     - orphaned tournament tables closed at startup
#     - pauseForBreak no longer leaves the level clock running through a break
#       (early-return leak)
#     - cap=0 tournaments finalize their prize pool at start (top-ups now run)
#     - mystery bounty reveal broadcast wired (overlay was dead)
#   server/src/engine/ChipRaceEngine.ts
#     - single-player branch rounds DOWN (was minting a free denomination)
#
# CLIENT (next SPA build):
#   src/services/TournamentService.ts
#     - getCurrentLevelState uses the SERVER-persisted current_level
#       (wall-clock derivation drifted past breaks/pauses/restarts and
#       mis-gated late-reg/rebuy/add-on windows); current_level added to selects
#     - unregister 1-minute-before-start cutoff enforced (UI promised it)
#   src/pages/TournamentPage.tsx  - mystery bounty reveal relay to overlay
#   src/pages/tournament/TournamentDetails.tsx
#     - prize pool displays use the authoritative DB pool (buy_in × entries
#       counted FREE horse entries — advertised prizes larger than real)
#
# DB (ALREADY APPLIED to production):
#   supabase/migrations/20260724d_tourney_audit_sweep4_rebuy_windows.sql
#     - process_tournament_rebuy now enforces rebuy/add-on/re-entry windows,
#       stack limits, player status, and one-add-on SERVER-SIDE (was
#       client-only gating, bypassable by direct RPC call)
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

git add \
  server/src/GameServer.ts \
  server/src/engine/ChipRaceEngine.ts \
  src/services/TournamentService.ts \
  src/pages/TournamentPage.tsx \
  src/pages/tournament/TournamentDetails.tsx \
  supabase/migrations/20260724d_tourney_audit_sweep4_rebuy_windows.sql \
  RAKE-BBJ-FULL-AUDIT-2026-07-24.md \
  DEPLOY-TOURNEY-SWEEP4.sh

echo "── staged set ──"
git diff --cached --stat
echo "── unstaged WIP (your other work should still show ' M') ──"
git status --short | grep '^ M' || true

git commit -m "TOURNEY-AUDIT sweep 4: cancel-path refunds+cleanup, real in-hand guards for table moves, server-authoritative level gating, rebuy-window RPC enforcement (applied), mystery reveal wiring, prize display integrity"
git pull --rebase origin main
git push origin main

echo ""
echo "DONE. server/** push auto-deploys the Hetzner engine."
