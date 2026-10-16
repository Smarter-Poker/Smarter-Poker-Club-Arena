# A Chip Rake Finding Is Measured Again

**Date:** 2026-10-16
**Migration:** `20261016101854_a_chip_rake_finding_is_measured_again.sql`
**Law:** `tests/a-chip-rake-finding-is-measured-again.law.test.ts`

## What The Digest Reported

The Oct 14 daily digest listed drift incidents open past their deadline (53
and 54, the second line a duplicate since removed from the digest).

## What The Rows Say

54 incidents were open past deadline on 2026-10-16. 52 were the Lightning
Internal Pilot's rake-law storm of 2026-10-15: 50 per-hand
`ledger_reconcile_log:over_spec` and `bbj_over_spec` incidents on Lightning
Pilot NLH 9 and NLH 6, and the two storm counters for those sources.

`20261015222121_a_lightning_hand_counts_every_player_dealt_in` had already
proved the money right and fixed the line that recorded `num_players` as the
number of payers instead of the number dealt in. Every one of the 50 flagged
hands still has that undercount on its settled `rake_records` row; across
133,482 cash hands of the last 48 hours exactly 148 rows disagree with
`hand_history.players`, all from that 40-minute pilot window, none since.

## Why It Stayed Open

1. `fn_rake_law_violations` priced a hand with `rr.num_players` first, so the
   settled rows read over spec for as long as they sat in a window.
2. `fn_ca_remeasure_entity` could not measure a chip `rake_law` entity, so the
   hourly escalator re-filed the stale findings as "could not tell" every hour
   for its 36-hour lookback. The storm counters recurred 70 and 60 times, the
   last at 09:52 UTC on 2026-10-16, from log rows written the day before.

## The Fix

- The rake law now prices with `GREATEST(rr.num_players, players dealt)`. On
  every other hand the two are equal, so nothing else moves.
- The re-measure now measures a chip cash table over 36 hours with the same
  pricing functions the law uses. A fixed condition is superseded at the next
  tick; a live one is filed on fresh numbers; an unreadable hand stays a
  finding.
- The 52 incidents are closed as `verified_remeasured`, each only after the new
  re-measure reads ok for its table in the same transaction.

No chips move. Nobody was over-raked and no drop was taken over spec, so there
is nothing to refund. Settled `rake_records` rows are not rewritten.
