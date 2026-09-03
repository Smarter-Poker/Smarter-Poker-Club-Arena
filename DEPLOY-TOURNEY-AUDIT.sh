#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# TOURNEY-AUDIT deploy (2026-07-24, sweep 3) — run on the Mac host:
#   bash ~/Documents/club-arena/DEPLOY-TOURNEY-AUDIT.sh
#
# EXPLICIT file staging only (never `git add -A` — protects unrelated WIP such
# as Horse V3). Ships the tournament/SNG/spin audit fixes:
#
# SERVER (push to main auto-deploys the Hetzner engine):
#   server/src/GameServer.ts
#     - [CRITICAL] restart no longer credits TOURNAMENT chip stacks to real
#       wallets (money mint) nor deletes tournament seats
#     - [CRITICAL] stuck COMPLETING tournaments are now RECOVERED WITH PAYOUTS
#       (winner + unpaid ITM places) instead of blind-flipped to COMPLETED
#     - bounty knocker = largest winner of the busted player's LAST hand
#     - mystery bounty pays the value assigned at registration (no more
#       unbounded Math.random minting); crypto RNG fallback
#     - PKO/bounty champion now collects their own bounty head
#     - simultaneous full-bust no longer double-pays 1st place
#     - blind-level clock persists (level resumes mid-flight after restart)
#     - add-on window flag persists across restart
#     - restart-orphaned SNG/Spins refund real players (buy-in + fee, with
#       fee reversal in the rake ledger)
#     - payout normalization also refreshes the in-memory cache (no more
#       over-paying late-reg top-ups from un-normalized percentages)
#   server/src/services/TournamentRecurringService.ts
#     - spin prize pool = buyIn × multiplier (was × players too — 2.75x
#       guaranteed house loss)
#     - bounty portion excluded from MTT/XMTT prize pools (was double-counted)
#     - horses no longer double-booked into simultaneous tournaments
#     - scheduler fails CLOSED on DB errors (no duplicate-creation storms)
#     - schedule hours are UTC
#
# CLIENT (ships with next SPA build):
#   src/services/TournamentService.ts
#     - blind validation no longer rejects EVERY break-containing structure
#       (hard tournament-creation blocker)
#     - late-reg seat lookup matches RUNNING tables (was case-mismatched —
#       every late-reg player was dumped to the alternates list)
#     - startTournament claims the start atomically (no more double
#       tables/seating when owner + server race) and seats players WITH stacks
#     - tables.current_players recorded at seating
#   src/pages/TournamentPage.tsx
#     - Start button disabled below 3 players (2 players = insta-cancel bug)
#
# DB: supabase/migrations/20260724c_tourney_audit_sweep3.sql — ALREADY APPLIED
#     to production (level clock + addon flag columns; 755 stranded horse rows
#     closed).
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

git add \
  server/src/GameServer.ts \
  server/src/services/TournamentRecurringService.ts \
  src/services/TournamentService.ts \
  src/pages/TournamentPage.tsx \
  supabase/migrations/20260724c_tourney_audit_sweep3.sql \
  RAKE-BBJ-FULL-AUDIT-2026-07-24.md \
  DEPLOY-TOURNEY-AUDIT.sh

echo "── staged set ──"
git diff --cached --stat
echo "── unstaged WIP (should still show your Horse work) ──"
git status --short | grep '^ M' || true

git commit -m "TOURNEY-AUDIT sweep 3: tournament lifecycle/payout/bounty/blind-clock fixes (server + client) — see RAKE-BBJ-FULL-AUDIT-2026-07-24.md"
git pull --rebase origin main
git push origin main

echo ""
echo "DONE. server/** push auto-deploys the Hetzner engine."
echo "Post-deploy verify (expect ZERO): completed tournaments with stranded"
echo "'playing' rows created after the deploy time."
