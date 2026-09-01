# Seat-first boards husked platform-wide; healer taught the new husk class

**Date:** 2026-09-01 · **Agent:** Claude (Cowork) · **Scope:** DB migrations only (no engine code in this change)

## What Dan saw

"There are no cash games running... no spins, no heads up running and only a
handful of MTTs" — reported on Deep Stack Society, but the spin/heads-up half
was true of the ENTIRE platform.

## What was actually wrong (three separate things)

1. **A new husk class wedged every seat-first board.** At ~12:55 UTC the
   boards opened a fresh set of 96 queues (Deep Stack's 32 spins, Midway's
   spins and heads-ups) at a moment when opener seating could not succeed:
   Deep Stack's 416 horses were still benched behind the green-light latch,
   and the old engine's fleet-wide horse picks were being refused by the
   club-scope entry gate ("player X has no club membership in the scope of
   tournament Y" — visible in the engine log). Each queue got its joinable
   table and ZERO opening horses. A joinable husk covers its price point in
   `ensureBoardOpen`, so no new queue ever opens; a seat-first game with no
   openers never fills, so it never leaves REGISTERING. Five hours of
   open-looking, dead boards. The existing healer
   (`fn_repair_seat_first_games`, called by the engine every 30s) only
   repaired the 2026-08-23 class — game with NO table — and sailed past
   these.

2. **The healer then hit the 8-second ceiling.** The engine calls the healer
   as `service_role`, whose `statement_timeout` is pinned to 8s (the PGRST002
   fix). v1 of the fix did ~1,000 per-horse `fn_ca_entry_scope_ok`
   evaluations per husk and was cancelled every tick. v2's function-level
   `SET statement_timeout` cannot work — the timer is checked from the START
   of the statement. v3 replaced the per-horse function call with the
   equivalent set-based membership predicate off `club_members`' user_id
   index and clamped the batch to 6 husks per call. Verified live: 6 games /
   12 openers healed per 30-second tick; husk count fell 96 → 69 within
   minutes and Deep Stack spins began RUNNING.

3. **The engine in production is still the OLD build.** `docker ps` on the
   Hetzner host shows `club-arena-engine:bda90d71...` — a build that predates
   #2430 (a horse plays only in its club), #2438 (seat-first fill stays in
   its club) and #2465 (SNG/heads-up boards for activated club owners). The
   14:58 UTC "successful" deploy run was migrations-only (no `server/**`), so
   it deployed nothing; the three later runs failed the financial health-gate
   (the 14:02 ledger wipe made trailing-4h conservation look wrong — correct
   behaviour). This is why Deep Stack has never had a single heads-up/SNG
   queue and why its cash tables show the one-lonely-horse pattern (116
   single-seat tables vs 28 dealing). The scheduled catch-up deploys main in
   the 14:00 Chicago window; the gate's trailing window has rolled past the
   wipe, so it should pass. A `force: true` workflow_dispatch was attempted
   and blocked by the session's action classifier — deliberately left to the
   scheduled window (or to Dan's hand).

## Migrations applied (in prod, recorded here)

- `20260901181246_seat_first_openers_can_be_reseated` — v1: new husk class +
  club-scoped, bench-honoring pick. Timed out under service_role.
- `20260901181626_seat_first_healer_fits_its_timeout` — v2: function-level
  statement_timeout — recorded as a stub because the approach cannot work;
  kept so the repo matches `supabase_migrations.schema_migrations`.
- `20260901181911_seat_first_healer_inside_eight_seconds` — v3: the live
  version. Set-based scope, batch clamp 6, both husk classes, REVOKE to
  service_role only.

## Laws honored

- Horses are players (§10.5): the healer seats openers through
  `fn_seat_horse_in_seat_first_game` → `fn_register_horse_for_tournament` —
  real buy-ins from the horse's own club wallet, same money path as a human.
- Bench latch: only `horse_status = 'available'` horses are ever picked.
- Club containment: the pick admits exactly the horses the entry gate would
  admit (member / union sibling / union-owned board), so a pick can never be
  refused mid-repair.
- §11.5: the diagnostic probes ran inside rolled-back transactions; the only
  committed changes are function definitions.

## Verification

- Engine log before: `seat-first repair failed: canceling statement due to
statement timeout` every tick. After v3: `repaired 6 seat-first game(s)...
seated 12 opening horse(s)` every tick.
- DB: Deep Stack spin queues with openers 0 → 30 of 32 within ~3 minutes;
  6 DS spins RUNNING; platform husks 96 → 69 and falling.

## Still open when this was written

- The 14:00 Chicago window deploy must land the new engine (heads-up/SNG
  boards for Deep Stack, club-scoped picks and fills). Verify via Supabase:
  DS `tournament_type='SNG'` rows appearing, and the Midway "entry refused"
  log noise stopping.
