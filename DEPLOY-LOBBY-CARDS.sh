#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# PUBLISH — Neon poker-table lobby cards (2026-07-25)
#   bash ~/Documents/club-arena/DEPLOY-LOBBY-CARDS.sh
# EXPLICIT staging only (never `git add -A`). Client SPA change → Vercel rebuilds on push.
#
# WHAT SHIPS:
#   src/components/lobby/DynamicGameCard.tsx  — neon-table cards (drop-in; same
#     exports CashGameCard/TournamentCard/SNGCard/SpinCard that ClubHomePage already
#     imports, so the lobby picks them up with no other change). Variant→emblem,
#     category→neon color, attributes→bottom-rail badges, live counts, tournament
#     start + live countdown. Cash cards have no clock.
#   src/components/lobby/NeonCard.css          — the neon-table styles (cards grow
#     to fit; nothing clips the rail).
#   public/game-card-icons/*.png (50)          — the club's custom emblems,
#     background-removed + web-optimized. Served at /game-card-icons/<name>.png.
#   src/pages/ClubHomePage.tsx                 — ALL view orders tournaments first
#     (open-for-reg, soonest first) → Hold'em → Omaha → Mixed; re-applies the live
#     BBJ fix (union-pool resolution + realtime subscription so the header jackpot
#     ticks up as rake funds it).
#
# NOTE: old unused *.jpg emblems + the temp zip were moved to _to_delete/ — you can
# delete that folder. It is NOT staged here.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

git add \
  src/components/lobby/DynamicGameCard.tsx \
  src/components/lobby/NeonCard.css \
  src/pages/ClubHomePage.tsx \
  public/game-card-icons/ \
  DEPLOY-LOBBY-CARDS.sh

echo "── staged set ──"
git diff --cached --stat
echo "── unstaged WIP (your other work should still show here, untouched) ──"
git status --short | grep '^ M' || true

git commit -m "Lobby: neon poker-table game cards with custom club emblems (variant art, attribute badges, live counts, tournament countdown)"
git pull --rebase origin main
git push origin main

echo ""
echo "DONE. Push triggers the SPA rebuild/deploy — the new lobby cards go live after it finishes."
