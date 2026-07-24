#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# TOURNEY-AUDIT SWEEP 5 deploy (2026-07-24) — run on the Mac host:
#   bash ~/Documents/club-arena/DEPLOY-TOURNEY-SWEEP5.sh
# EXPLICIT staging only (never `git add -A`).
#
# SERVER (push auto-deploys the Hetzner engine):
#   server/src/GameServer.ts
#     - [CRITICAL — money mint] BOTH under-filled auto-cancel paths (discovery
#       loop 30-min sweep + start()-time <3-player cancel) refunded buy-in+fee
#       to EVERY registered row INCLUDING HORSES who paid nothing — hundreds
#       of cancels/week each minted horse entry money from thin air. Both now
#       route through the shared cleanup: real players only, fee reversal,
#       player rows closed (not deleted), CAS-guarded cancel claim.
#     - Final standings normalized at tournament finish: zero-prize finishers
#       re-ranked by bust time over the FINAL entrant count (positions only —
#       paid places and money untouched). Fixes late-reg position skew and
#       arbitrary same-sweep tie ordering.
#
# CLIENT (next SPA build):
#   src/services/TournamentService.ts
#     - level countdown now derives from the server-persisted level clock
#       (tournaments.level_started_at) — the lobby/details timer finally
#       matches the engine's real timer; level_started_at added to selects.
#
# DB (ALREADY APPLIED): supabase/migrations/20260724e_tourney_audit_sweep5.sql
#     - hand_history (tournament_id, created_at DESC) partial index — the
#       stale sweep / activity checks were scanning 1.4M+ rows.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

git add \
  server/src/GameServer.ts \
  src/services/TournamentService.ts \
  supabase/migrations/20260724e_tourney_audit_sweep5.sql \
  RAKE-BBJ-FULL-AUDIT-2026-07-24.md \
  DEPLOY-TOURNEY-SWEEP5.sh

echo "── staged set ──"
git diff --cached --stat
echo "── unstaged WIP (your other work should still show ' M') ──"
git status --short | grep '^ M' || true

git commit -m "TOURNEY-AUDIT sweep 5: horse-refund mint closed on both auto-cancel paths, final-standings normalization, server-clock level countdown, hand_history tournament index (applied)"
git pull --rebase origin main
git push origin main

echo ""
echo "DONE. server/** push auto-deploys the Hetzner engine."
