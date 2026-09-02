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

## Create Table — dead route removed, validation ported to the DB (2026-08-31)

The World Hub route pages/api/club-arena/create-table.js had ZERO callers, so
none of its validation ever ran on a real table. Route deleted (World Hub PR
#1051, merged) along with its RateLimiter entry, and the validation that
actually prevents broken tables now lives in the DB where every writer hits it:
migration 20260831_table_creation_guard_replaces_dead_create_table_api.sql adds
BEFORE INSERT trigger fn_tables_creation_guard enforcing the cash SEAT LAW
(plo6 6 / plo5 7 / plo4,plo8,flo8 8 / else 9 — over-seating makes the engine
throw 'Not enough cards in deck' and the table can never deal), positive and
ordered blinds, min_buy_in <= max_buy_in, action_time 10-120, and name
hygiene (trim, 60 chars, angle brackets stripped). Tournaments are exempt from
the seat law per tableSeating.ts. Client slider floor raised 5s -> 10s to match.

Verified live: guard refuses a 10-max PLO6 and inverted blinds, accepts a legal
6-max PLO6, leaves no probe rows behind, and cash_tables_needing_engine() still
returns the live fleet (26).

Still open for Dan (NOT invented into a guard): the official stakes-schedule
match, rake/BBJ tier auto-fill, and the settings JSONB payload the dead route
carried. Live tables already sit outside those, so they need a ruling first.

## Noted, not changed (need Dan / follow-up)

- Repo migration 20260827 still contains the banded fn_spin_rake_rate +
  assertions; superseded by the 20260830 migration on replay order.
- trg_tables_union_ownership DOES exist in production (verified 2026-08-31) but is in no repo migration — repo/DB drift to reconcile.
- is_premium_spin column is write-only.
- Sign-in page artwork shows "You Are Already Signed In" panel even when no
  session exists (background image, not state), and Continue To Hub then does
  nothing (overlay buttons only render with a real session).
- Repo RLS drift: live DB tables policies are correct (tables_insert_owner_or_admin);
  the permissive 20260124400 policy no longer exists live but is still in repo history.

Tests: tsc clean; vitest spinSpec/spinNoExtraRake (50), HorseOrchestrator,
tableConfigSeatLawClamp, oneTableWriter, engineSelectIsTheContract,
lobbyMobileCards (137) all green.
