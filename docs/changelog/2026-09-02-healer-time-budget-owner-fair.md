# 2026-09-02: seat-first healer is time-budgeted and owner-fair

## Symptom

Deep Stack Society's Spin board: 31 REGISTERING queues, zero tables, zero
openers, for over an hour. Engine log every pass: either
`repaired 6 seat-first game(s)` (all Midway rows) or
`seat-first repair failed: canceling statement due to statement timeout`.

## Root cause (measured)

- `fn_seat_horse_in_seat_first_game` costs 0.4s idle and 2.1s under the load
  the engine was running at (75% CPU, board ticks overlapping).
- v3 healed the 6 OLDEST eligible husks per call. Deep Stack's husks were all
  Class A (no table, two openers each): 6 x 2 x ~2s = well over the engine's
  pinned 8s `statement_timeout`. Every pass that reached them rolled back.
- Midway's husks were Class B (one opener short): cheaper, so those passes
  succeeded, and `ORDER BY created_at` handed the same rows back every time.

## Fix: `fn_repair_seat_first_games` v4

1. A 5-second wall-clock budget replaces the row cap. The healer does as much
   as fits and returns `out_of_time` + `elapsed_ms`. It cannot time out.
2. Owner-fair ordering: `row_number() OVER (PARTITION BY club_id)` first, so
   every owner's first husk is healed before any owner's second.
3. The eligible-horse pool is built once per owner per call and popped, not
   re-queried (400ms) per opener.

Applied to production as `healer_time_budgeted_and_owner_fair`; recorded here
as `supabase/migrations/20260902052500_healer_time_budgeted_and_owner_fair.sql`.

## Verified

Next engine passes: `repaired 4 seat-first game(s); seated 7 opening horse(s)`
with no timeouts; Deep Stack `queues_with_table` 0 -> 4 in one pass and
climbing.

## Note for anyone calling it by hand

`fn_guard_managed_game_lifecycle` exempts `service_role` only. A manual call
as `postgres` trips "cannot be modified after a player has registered" on the
start_time refresh and rolls the whole pass back. Let the engine run it.
