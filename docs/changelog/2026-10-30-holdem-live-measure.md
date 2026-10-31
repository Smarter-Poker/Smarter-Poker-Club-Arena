# Hold'em live measure (2026-10-30)

The October 30 Hold'em release (#8692 heap, #8694 V60, #8733 V62, #8705 V61)
is judged on four live numbers once a revision containing it serves. This is
the toolkit that reads them, built and unit-tested ahead of the cutover so the
measurement is ready the moment the engine is, and so EED's figures are never
attributed to the fix (the report names the serving release).

- `server/src/benchmark/HoldemLiveMeasure.ts` (pure, no imports):
  1. `heapSlopes` - least-squares GB/hour of `heapUsedMb` and `rssMb` per
     engine instance from `/health` samples; a restart is a new instance and
     a new line; fewer than three samples or under twenty minutes answers
     `null` with a reason, never 0.
  2. `threeBetShares` - 3-bet% and fold-to-3-bet% per format and overall from
     `horse_daily_play`, the accumulator the tuner and the panel already read.
     Unfloored tables only (`floored = false`), as the tuner reads them - a
     VPIP-floored table forces 40-70% VPIP; the table carries no variant, so
     this is every variant, and the report says so.
  3. `riverOnePairCalls` - how often a horse that called a river bet holding
     exactly one pair won, by the V62 size class of the bet faced (small
     < 0.4 pot, medium < 0.7, large or a raise). Reads `horse_hand_reviews`
     (card objects or strings). Amounts follow the engine's own convention,
     checked in `HandController.processAction`: a `call` is the increment, a
     bet / raise / all-in / forced post is the street total, a dead post
     (ante) is pooled separately - the first draft took every amount as a
     street total and undercounted each blind defence, shifting size classes
     upward (caught in review). Hold'em rows only (`game_variant = 'nlh'`,
     12,207 of ~62,000 daily rows), so the row cap is spent on Hold'em; a
     board flush or board straight is not a one-pair call. Caveat carried in the report: those rows exist only for hands
     with |net| >= 20bb, so this is the big-pot subset - compare before and
     after on the same subset.
  4. `receiptCounts` - `horse_brain_telemetry` fires per day for
     `v61_river_one_pair_shade`, `v62_river_bettor_polarity` and the two V38
     river receipts beside them. V62 is opt-in (default off since #8781), so
     zero V62 fires on a containing revision is the expected state; the
     report says so.
- `server/scripts/holdem-live-measure.ts`: `sample-health --samples FILE`
  appends one `/health` sample; `report --samples FILE --since-hours N --out
  PATH` runs bounded SELECTs (play rows by day; Hold'em review rows in keyset
  pages of 2,000 newest-first up to 20,000; telemetry by day and feature) and
  writes `<out>.json` and `<out>.md`.
  Credentials come from the environment the engine already has and are never
  printed. No RPC that writes, no retry loop, no scan.

Column names and the stored card/action shapes were checked against
production with SELECT-only reads before the parser was pinned. The live
`sample-health` call was exercised once (EED `1-a474c9ca`, heap 3,027 MB,
RSS 13,442 MB at 21:33 UTC).

Tests: `server/src/benchmark/HoldemLiveMeasure.test.ts` (10) - slopes per
instance and the null-with-reason cases, shares per format with distinct
horses, the one-pair evaluator against sets / two pair / flush / straight,
the river call faced with street-total amounts, raises and short all-in
calls, the size-class table from fixture rows, card objects, receipt counts
and the rendered report.

## CI type-check gap (2026-10-31)

`server/tsconfig.json` has `rootDir: src`, so no CI job ever compiled
`server/scripts/*.ts` - this CLI and the five operator scripts before it were
checked by hand. `server/tsconfig.scripts.json` now type-checks every script
(the `scripts/qualification/**` vitest files are excluded by name; they
carried 36 pre-existing errors and are run by their own harness), the Server
Engine job runs it right after the server compile, and
`tests/server-scripts-are-type-checked.law.test.ts` pins both.
