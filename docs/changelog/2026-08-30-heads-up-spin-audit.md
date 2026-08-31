# 2026-08-30 — Heads-Up (Spin) Full Audit + Fixes

Live production verification (Supabase, last 48h): 2,698 completed spins, every
winner paid exactly buy_in x multiplier via fn_credit_and_log (0 unpaid, 0
wrong amounts; multi-row payouts only on 10x+ premium splits, by design). No
stuck REGISTERING/RUNNING spins. Reserve pool solvent (60,987.72 balance,
can_draw_100x true), 0 unpaid settlements, 0 draw-booking gaps since 2026-08-25,
all 41 shortfall backpay rows paid. Multiplier distribution matches spinSpec.
fn_spin_sweep_unbooked() run post-change: ok, settled 0, failed 0.

## Fixed
1. **fn_spin_rake_rate (DB) was still banded 8/7/6/5%** while spinSpec is flat
   8% (Dan 2026-08-27 ruling) — the sweep recovery path booked a different
   rake/reserve deposit than the engine for buy-ins over 5. Flattened to 0.08.
2. **fn_spin_sweep_unbooked settled on count(tournament_players)** — now
   settles at SPIN_SEATS = 3, matching the engine exactly.
3. **tables.game_type format law**: TableConfigPage wrote the VARIANT
   ('NLH', 'PLO6', ...) into tables.game_type, so owner-created cash tables
   never matched the sit-out / zero-chip eviction sweeps' game_type='cash'
   gate (zombie seats held engines forever). Writer fixed to 'cash', 3 live
   rows backfilled, CHECK (game_type IN ('cash','tournament')) added.
   Migration: 20260830_spin_flat_rake_sweep_seats_and_table_game_type_law.sql
   (applied to production via Supabase MCP same day).
4. **SPIN_BLIND_STRUCTURE (client)** was a hand-typed 15-level, 2-minute
   ladder diverging from spinSpec at level 5 — the pre-start Blinds tab showed
   a ladder that never played. Now derived from spinSpec SPIN_BLINDS, 3-min.
5. **HorseOrchestrator.launchSpin retired** (window-debug only, no production
   caller): it registered horses instead of selling seats and overwrote
   current_players — the documented "0/3 with paid seats" incident shape. It
   now refuses loudly; spins are created only by TournamentRecurringService.
6. **World Hub create-table.js**: emoji removed from notification title.

## Noted, not changed (need Dan / follow-up)
- World Hub /api/club-arena/create-table.js is DEAD code — the live create
  path is a direct client insert in TableConfigPage, so the API's rate
  limiting, role checks, stakes-schedule validation and rake/BBJ tier
  auto-fill never run. Decide: wire the client through the API, or port the
  validation into RLS/triggers and delete the route.
- Repo migration 20260827 still contains the banded fn_spin_rake_rate +
  assertions; superseded by the 20260830 migration on replay order.
- trg_tables_union_ownership is cited in comments but exists in no migration.
- is_premium_spin column is write-only.
- Sign-in page artwork shows "You Are Already Signed In" panel even when no
  session exists (background image, not state), and Continue To Hub then does
  nothing (overlay buttons only render with a real session).
- Repo RLS drift: live DB tables policies are correct (tables_insert_owner_or_admin);
  the permissive 20260124400 policy no longer exists live but is still in repo history.

Tests: tsc clean; vitest spinSpec/spinNoExtraRake (50), HorseOrchestrator,
tableConfigSeatLawClamp, oneTableWriter, engineSelectIsTheContract,
lobbyMobileCards (137) all green.
