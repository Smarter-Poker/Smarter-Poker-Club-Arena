# The Weekly Close Fits Its Tick (2026-10-16)

Follow-up to `2026-10-16-the-weekly-close-proofs-outlive-the-close.md`, same
request from Dan: "GIVE THE RAKE BACK MORE TIME (UNLIMITED IF POSSIBLE)."

## What Was Still Wrong

With the two-hour windows lasting 72 hours, the union close for the week of
October 5 still ran out of job 272's 240 second tick on every visit. Two
causes, both measured inside rolled-back probes:

1. **The commission evidence check took 77.9 seconds, twice per attempt.**
   `fn_assert_cash_commission_period` looks for a cash rake record of the week
   with no accrued batch. The planner ran its per-row function predicates
   (ghost twin, launch window, union membership) on all 606,825 records before
   it looked at the batch status. The week has none unaccrued; asked directly,
   the anti-join answers in 1.8 seconds.
2. **My first fix broke an inventory seal.** `fn_accounting_close_certificate`
   is one of the 40 proof sources sealed by md5 in
   `smarter_private.original_inventory_proof_sources_match()`. Rewriting it in
   `20261016123337` made the inventory generation NULL from 12:33, so every
   P&L certificate stopped qualifying and preparation re-proved the week's
   flow evidence live (past 230 seconds).

## What Changed

- `20261016131916`: the same check, with the unaccrued candidates found first
  in a MATERIALIZED CTE and only those paying for the function predicates.
  Every condition and the refusal are unchanged.
- `20261016133404`: `fn_accounting_close_certificate` back on its exact sealed
  body, asserted by md5 before and after; the generation returned
  (`original-inventory-245-v1:96ac03a8...`). The other nine readers keep the 72
  hour lifetime; the six combined certificates keep 12 hours, and each is
  rebuilt from 72 hour windows or in one bounded step (the opening boundary
  took 66.5 seconds).
- The live proof of `20261016123337` now counts the nine functions that still
  carry the 72 hour lifetime.

- `20261016142840`: `fn_weekly_accounting_attempt_begin` caps an attempt's
  deadline at 60 seconds before the statement's own timeout. A union visit
  that started two minutes into the 240 second tick had been measuring three
  minutes from its own start, so its bounded steps never stopped in time and
  the whole attempt was cancelled with nothing kept.
- `20261016144115`: with the deadline fixed, attempt 157 (14:20) reached round
  1, paid the clubs, and then refused its own receipt
  (`union_close_invoice_receipt_missing`). Dan's rule of 2026-10-15
  (`20261015184608`) sends only cashout documents to the messenger and marks
  every other invoice delivered in transaction history "so the weekly close is
  satisfied", but seven readers still demanded a messenger delivery row: the
  union round 1 receipt, the retained share, the legacy week discharge, the
  club weekly statement and its summary, and the correction and credit-change
  document checks. Each now accepts a marked-sent invoice other than
  `cashier_cashout`; a cashout still needs its deliveries.

## Verified Live

All recorded (`20261016123337`, `20261016131916`, `20261016133404`, `20261016142840`, `20261016144115`); the inventory generation is intact after each.
Attempt 156 at 13:40 finished in 88 seconds instead of timing out and
certified the opening boundary; the close is moving again.

## Pinned

- `tests/the-commission-evidence-check-reads-only-what-is-unaccrued.law.test.ts`
- `tests/the-sealed-certificate-reader-keeps-its-sealed-body.law.test.ts`
- `tests/a-close-attempt-ends-before-its-tick-does.law.test.ts`
- `tests/a-weekly-close-accepts-a-history-only-invoice.law.test.ts`
