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

## Verified Live

All three recorded (`20261016131916`, `20261016133404`, and `20261016123337`).
Attempt 156 at 13:40 finished in 88 seconds instead of timing out and
certified the opening boundary; the close is moving again.

## Pinned

- `tests/the-commission-evidence-check-reads-only-what-is-unaccrued.law.test.ts`
- `tests/the-sealed-certificate-reader-keeps-its-sealed-body.law.test.ts`
