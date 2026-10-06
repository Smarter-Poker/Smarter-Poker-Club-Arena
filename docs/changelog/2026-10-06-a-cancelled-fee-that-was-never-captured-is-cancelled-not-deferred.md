# A cancelled fee that was never captured is cancelled, not deferred (2026-10-06)

Migration: `supabase/migrations/20261006140724_a_cancelled_fee_that_was_never_captured_is_cancelled_not_def.sql`
Law: `tests/a-cancelled-fee-that-was-never-captured-is-cancelled-not-deferred.law.test.ts`

## What stopped

The weekly close for 2026-09-28 07:00 to 2026-10-05 07:00 UTC. The club recompute
requests for Deep Stack Society (2a1132b9), SHARK CLUB (a41434bb) and
a0000000 were `blocked` / `tournament_recognition_deferred`, raised by
`fn_accounting_tournament_week_quality` for a recognition in status
`banked_accrual_deferred`. Exactly four such recognitions existed in the whole
table, all written at 2026-10-02 02:16:54.388496 by `atomic_cancel_tournament`:

| tournament | scope | fees charged 2026-09-08 | refunded 2026-10-02 | net |
| --- | --- | --- | --- | --- |
| 097e3601 | Midway Union | 7.50 + 7.50 | -7.50, -7.50 | 0 |
| 92c93927 | Midway Union | 0.75 + 0.75 | -0.75, -0.75 | 0 |
| a4262ba0 | Midway Union | 0.75 + 0.75 | -0.75, -0.75 | 0 |
| 20c75b67 | Deep Stack Society | 0.75 + 0.75 | -0.75, -0.75 | 0 |

All four are cancelled satellites whose entrants were refunded in full
(cancellation receipt: fully settled, `fees_reversed = total_rake_before`,
`total_rake_after = 0`). The entry fees were charged before fee-source capture
existed, so they have no `accounting_tournament_fee_batches` row and no fee
sources.

## The cause

`fn_accounting_tournament_fee_net_plan` required a captured batch for every
positive fee row and raised `tournament_fee_sources_require_reconciliation`
(55000) before it looked at the refunds. A pre-capture fee refunded to zero by
a cancellation was treated exactly like an earnable fee with missing
attribution. `fn_record_accounting_tournament_cancellation` caught the 55000
and filed the event through `fn_defer_accounting_tournament_fees` as
`banked_accrual_deferred`, which the weekly gate refuses for ever.

## The fix

At the rule, in the net plan: only when the tournament's raw fee total is
exactly zero, a positive row with no batch and no source, named by an
`atomic_cancel_tournament` reversal listed in an exact-zero cancellation
receipt, is excused from the capture check. The refund loop is unchanged and
still proves every reversal exact, and a new assertion requires every excused
row to have been refunded by it. The plan then proves net 0 with no sources,
and `fn_recognize_accounting_tournament_fees` writes `cancelled`.

Nothing else moves: a positive net (earnable or partially reversed) excuses
nothing, a captured or sourced row is never excused, and an unregistration
refund excuses nothing. `fn_accounting_tournament_week_quality` needs no
change: an event with a negative fee row always takes its slow path, which is
this net plan.

## The damage

The four recognitions are restated in place to the row
`fn_recognize_accounting_tournament_fees` writes for a zero-net cancellation:
status `cancelled`, `net_rake` 0, `union_id` NULL (the plan's union, since there
are no fee sources), plan = the proven net plan, with the previous row kept in
`plan.restated_from`. `recognized_at` (the cancellation instant),
`bank_club_id`, the bank receipt ids (both NULL) and `source_fingerprint` are
unchanged. The immutability trigger is disabled and re-enabled inside the one
transaction. No chips move and no wallet, ledger, commission or VIP row is
written: nothing here was ever earnable. Horses are treated exactly as players
throughout; the rule does not read `is_horse`.

## Proof (production, one self-aborting DO block per call, rolled back)

pg_temp copies of the patched net plan and of the week-quality reader (reading
a temp view that overlays the four restated rows):

- substitution anchors 3 x 1, reverse substitution reproduces md5 `9b1147a5...`;
- the live net plan still raises `tournament_fee_sources_require_reconciliation`
  for 097e3601; the patched one proves all four `proven`, net 0;
- week quality over [2026-09-28 07:00, 2026-10-05 07:00): 2a1132b9 `ready`
  (checked 81317), a41434bb `ready` (93826), fade0000 `ready` (93832),
  a0000000 `ready` (93822);
- negative control: earnable uncaptured COMPLETED tournament 9664eac4 (net
  0.24) still raises `tournament_fee_sources_require_reconciliation`;
- the old and new net plan agree on the 300 most recent recognitions (300
  same, 0 different).

## What still holds the Midway Union close

The union run's stage `certifying` is NOT these four. It is the closing P&L
boundary, `fn_union_pnl_boundary(fade0000, 2026-10-05 07:00)`, which returns
`blocked` with 86 `open_tournament_original_instrument_or_earning_club_missing`
registrations in three tournaments: fa723374 (Sunday Funday Six-Card Closer,
COMPLETED, 50), 73ff3bdc (Wednesday Feature, REGISTERING, 35) and 6561f9f4
(Sunday $200 Deep Stack, REGISTERING, 1). A step that finds a problem is never
certified, so each chunked attempt re-proves it (~46s), hits the warm stop and
records `certifying` again. After this migration the union's member-club
recompute requests will no longer be blocked by the four events, but the union
close will stay in `certifying` until that boundary defect is fixed.
