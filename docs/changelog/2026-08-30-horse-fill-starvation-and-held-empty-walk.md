# 2026-08-30 — Horse fill starvation + held-empty walk

Two engine starvation bugs, found live (SNG board dead since 17:31 UTC,
short_deck room dark since 09:14 UTC), fixed together.

## 1. pickFreeHorses / registerHorses drained a stable page

Both read `profiles` with `.eq('is_horse', true)` plus a LIMIT and **no ORDER
BY and no busy exclusion**. Postgres serves the same physical first page for
that query all day, so every caller drew from the same ~200 rows of a
584-horse fleet. Once that page's horses hit the 4-game cap, the
filtered-after-fetch candidates shrank to zero and every seat-first fill
starved while two-thirds of the fleet idled beyond the page.

Fix (`server/src/services/TournamentRecurringService.ts`):

- Both reads now fetch the WHOLE fleet keyset-paged via `fetchAllRows`
  (the `HorseFleetManager.seedAllTables` pattern), fail closed on an
  incomplete read, and filter/shuffle in memory.
- The busy (4-game cap) and lane/activity filters are unchanged in meaning
  and now live in the exported pure helper `selectHorseCandidates`, unit
  tested without a database.
- The shuffle now runs BEFORE the cash-room reserve trim, so the horses held
  back for the cash room are not always the same tail of an id-ordered list.
- `pickFreeHorsesLimits.test.ts` re-pinned to the new shape (paged, ordered,
  fail-closed) for both functions.

## 2. cashTableHeldEmpty walked instead of re-rolling

`horseHash(tableId + ':empty:' + bucket) % 100` advances by roughly +1 per
2h bucket (weak `h*31+c` hash on a nearly identical string), so a table that
entered the <15 held-empty band stayed held ~15 consecutive buckets — about
30 hours. Identical to the seat-first hold bug fixed on 2026-08-27, one file
over.

Fix (`server/src/services/HorseBehavior.ts`):

- Same murmur3 `mix32` avalanche + golden-ratio bucket spread as
  `seatFirstHeldEmpty`, so every bucket re-rolls independently.
- NEW LAW: a variant must never go fully dark. `HorseFleetManager` publishes
  the set of tables that are currently the only open one for their variant
  config (`setSoleOpenCashTables`, grouped by variant + blinds + seats), and
  the hold never applies to those.
- Corrected the false comment in `TournamentRecurringService.ts` that claimed
  the cash hash "was written correctly and rotates every 2h".
- `HorseOccupancy.test.ts` bucket-stability pin aligned to the bucket start
  (it only passed before because adjacent buckets were correlated — the bug).

## Tests

New `server/src/services/heldEmptyRotationAndSoleOpen.test.ts`:
consecutive-bucket decorrelation (max run + conditional transition rate),
per-bucket fraction, sole-open guard semantics, and `selectHorseCandidates`
busy-exclusion / whole-fleet coverage / allLanes activity-window behaviour.

`server tsc --noEmit` clean; touched suites green locally (59 tests).
