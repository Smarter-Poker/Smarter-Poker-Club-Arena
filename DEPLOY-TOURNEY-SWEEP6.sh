#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# TOURNEY-AUDIT SWEEP 6 deploy (2026-07-24) — run on the Mac host:
#   bash ~/Documents/club-arena/DEPLOY-TOURNEY-SWEEP6.sh
# EXPLICIT staging only (never `git add -A`). TablePage.tsx is intentionally NOT
# touched by this sweep (another workstream owns it).
#
# NOTE: run DEPLOY-TOURNEY-SWEEP5.sh FIRST if it has not been pushed yet — sweep 6
# builds on the sweep-5 GameServer/TournamentService edits.
#
# SERVER (push auto-deploys the Hetzner engine):
#   server/src/services/TournamentRecurringService.ts
#     - SNG/Spin DEFAULT = wait for ONE human seat; every 10th created SNG/Spin
#       instead launches a FULL-HORSE verification game so rake collection,
#       allocation, tracking, blind levels and payouts are exercised end-to-end.
#   server/src/GameServer.ts
#     - ensureLateRegSeated(): server-authoritative late-reg seating — any
#       registered/playing row with no active seat is seated at the emptiest live
#       table; if all tables are full the player is promoted so dynamic expansion
#       spawns a new table and the seat draw rebalances. A "new player" is never
#       left waiting or unseated (MTT waitlisting is eliminated by design).
#     - processSatelliteAwards(): top finishers auto-registered into the target
#       tournament (or paid ticket-value cash when the target is closed/missing);
#       per-elimination and winner CASH payouts are skipped for satellites.
#   server/src/services/supabase.ts
#     - notifyWaitlistSeatOpen(): CASH-tables-only. On a seat opening, claims the
#       oldest 'waiting' table_waitlists row via CAS → 'notified' and inserts a
#       'waitlist_seat_open' notification. Hooked in processLeavePending + atomicCashout.
#   server/src/services/RakebackSettlerService.ts
#     - Tournament invariant SENTINEL: each settler cycle scans newly-COMPLETED
#       tournaments and reportError()s on any (1) payout≠prize_pool for full-pool
#       events, (2) stranded playing/registered rows, or (3) raked tournament hand.
#       Watermarked in daemon_state 'tournament_sentinel'. Read-only — never mutates.
#
# CLIENT (next SPA build):
#   src/services/TournamentService.ts
#     - client late-reg seating replaced with pure registration (engine seats
#       within ~5s); satellite_target_id persisted on create.
#   src/services/WaitlistService.ts                 (NEW — cash waitlist client API)
#   src/components/tournament/TournamentHUD.tsx      (NEW — standalone felt HUD,
#       ready to drop into TablePage later; DO NOT wire TablePage in this sweep)
#   src/pages/TournamentPage.tsx                     (lobby: live "Lv N · MM:SS" chip)
#   src/pages/tournament/TournamentDetails.tsx       (quick-stats: live level+countdown)
#
# DB (ALREADY APPLIED): supabase/migrations/20260724f_tourney_audit_sweep6.sql
#     - tournaments.satellite_target_id + FK; public.table_waitlists (+ indexes,
#       CHECK, UNIQUE, RLS). File is the idempotent repo record of the live change.
#
# VERIFY (rerunnable after deploy):
#   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/verify-tournaments.mjs 100
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

git add \
  server/src/GameServer.ts \
  server/src/services/TournamentRecurringService.ts \
  server/src/services/supabase.ts \
  server/src/services/RakebackSettlerService.ts \
  src/services/TournamentService.ts \
  src/services/WaitlistService.ts \
  src/components/tournament/TournamentHUD.tsx \
  src/pages/TournamentPage.tsx \
  src/pages/tournament/TournamentDetails.tsx \
  supabase/migrations/20260724f_tourney_audit_sweep6.sql \
  scripts/verify-tournaments.mjs \
  RAKE-BBJ-FULL-AUDIT-2026-07-24.md \
  DEPLOY-TOURNEY-SWEEP6.sh

echo "── staged set ──"
git diff --cached --stat
echo "── unstaged WIP (your other work — e.g. TablePage.tsx — should still show ' M') ──"
git status --short | grep '^ M' || true

git commit -m "TOURNEY-AUDIT sweep 6: SNG/Spin one-human default + full-horse sim games, server-authoritative MTT late-reg seating & table redraw, satellite seat awards, cash-game waitlist, tournament money-conservation sentinel, lobby/HUD live level+countdown, verify-tournaments scorecard (migration applied)"
git pull --rebase origin main
git push origin main

echo ""
echo "DONE. server/** push auto-deploys the Hetzner engine."
echo "Then rebuild/deploy the SPA for the client-side lobby/HUD + WaitlistService changes."
