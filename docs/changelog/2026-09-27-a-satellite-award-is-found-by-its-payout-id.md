# A satellite award is found by its payout_id, not by (tournament_id, place)

**Root cause found and fixed by the Production Alerts fleet, PRIMARY lane, 2026-09-27.**

## What was wrong

`fn_tournament_money_conservation` raised 14 fresh `financial_alerts` starting
2026-09-26 ("Tournament retained money it never paid out" x12, "Tournament
paid out money it never collected" x2) against live, healthy tournaments.

Traced one in full: "Six-Card Feature" (`cf03a62c-3f77-43b4-82ff-c68c8b1cace1`)
reported `delta = +160.00`. Its `seat_income` term (in
`fn_tournament_conservation_delta`) counted 9 satellite payout rows worth
180.00 as "arrived seats". 8 of those 9 (160.00) were still-**unredeemed**
tickets (`tournament_tickets.status = 'issued'`, `redeemed_at IS NULL`) - the
holders had not entered this tournament at all.

The bug: the CTE finds a payout row's `tournament_satellite_awards` row with

```sql
LEFT JOIN tournament_satellite_awards a
       ON a.tournament_id = sp.tournament_id AND a.place = sp.position
```

but `tournament_payouts.position` is `NULL` on these ticket-delivery rows (a
gap on that column, not a "no award exists" signal). When the join misses,
`COALESCE(a.delivery_kind, 'seat')` falls back to "no award row = the legacy
direct-seat path, which always arrived" - correct when there truly is no
award row, silently wrong when there is one the join failed to find.

Confirmed for all 8 phantom rows in "Six-Card Feature": each has a real,
unique `tournament_satellite_awards` row (place 1-5, on the satellite side),
reachable by its own `payout_id`, every one still `status='issued'`.

## The fix

`tournament_satellite_awards.payout_id` is `UNIQUE`, `NOT NULL` on all 2,084
live rows, and `FK`-constrained to `tournament_payouts.id` (measured on
production before writing the migration). Re-keyed both the `seat_income` and
`seat_paid_out` CTEs in `fn_tournament_conservation_delta` on
`a.payout_id = sp.id`. A true cash-delivery-with-no-award-row case (the
2026-09-25 fix) is unaffected: it still has no `tournament_satellite_awards`
row under either join key.

Migration: `supabase/migrations/20260927212910_conservation_delta_seat_award_join_by_payout_id.sql`.

## Update, 21:30 UTC: rebuilt on the current function body

The first migration (20260927091102) was never applied and was written against the 09:11 body. At 15:09 main
applied 20260927150903, which taught the same function about a reviewed void's overlay return. Applying the
09:11 body would have silently removed that. The migration is now 20260927212910, restating the live body
(prosrc md5 ce248ae34ecb66dd36a55c50fee8d07b) with only the two award joins changed, and it restates the
service-role-only grants the definer-authorization check requires. Re-measured read-only against production:
16 open alerts, 14 go to 0.00 (including three filed after the first probe: Saturday Night Big Stack +2,850.00,
Friday Night Feature +480.00, Saturday Stackfest Opener +160.00); the two Sunday $200 Deep Stack events stay at
-180.00. Across all 493 finished events of the last 10 days with a satellite payout on either side, 14 change,
every one from non-zero to 0.00, and none moves away from 0.00.

## Verified before shipping

Recomputed all 14 flagged tournaments' deltas with the corrected join
(rolled-back probe against production, no committed side effects):

| Tournament                      | Reported delta  | Corrected delta         |
| ------------------------------- | --------------- | ----------------------- |
| DSS Thursday $22 NLH Deepstack  | +80.00          | **0.00**                |
| Six-Card Feature                | +160.00         | **0.00**                |
| Friday Night Feature            | +2070.00        | **0.00**                |
| Sunday Funday Six-Card Closer   | +350.00         | **0.00**                |
| DSS Monday $22 NLH Deepstack    | +260.00         | **0.00**                |
| Wednesday Feature (x2)          | +40.00 / +20.00 | **0.00** / **0.00**     |
| DSS Wednesday $22 NLH Deepstack | +40.00          | **0.00**                |
| Sunday Funday Warm-Up           | +1950.00        | **0.00**                |
| Sunday Funday Main Event        | +1300.00        | **0.00**                |
| DSS Tuesday $22 NLH Deepstack   | +360.00         | **0.00**                |
| Sunday $200 Deep Stack (x2)     | -180.00         | **-180.00 (unchanged)** |

12 of 14 false positives resolve to exactly 0.00. The two `-180.00`
("Sunday $200 Deep Stack") rows are **not** explained by this bug and remain
open under a separate incident_key on the fleet board for a dedicated pass.

This is a detection-only fix: `fn_tournament_conservation_delta` is a
read-only, `STABLE SECURITY DEFINER` SQL function with no side effects. No
chips moved as a result of this migration. The 12 now-explained
`financial_alerts` rows are resolved separately in the fleet board (not in
this migration) once this fix is confirmed live in production.

## Hardening

- Regression test: `tests/a-satellite-award-is-found-by-its-payout-id.law.test.ts`,
  proven red on the pre-fix migration and green after.
- Law registry entry: `docs/laws.d/a-satellite-award-is-found-by-its-payout-id.md`.
- Existing detector (`fn_tournament_money_conservation`, unchanged) is the
  net that will confirm no recurrence once this ships.
