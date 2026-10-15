# A Ticket Paid In Cash Never Arrived At Its Target (2026-10-15)

## What Fired

The deep money-conservation pass (`tourney_money_conservation_deep_daily`,
03:25 UTC) raised 56 `fn_tournament_money_conservation` alerts in one run:
"Tournament retained money it never paid out", every one a completed
freezeout target of direct satellites, deltas from 20.00 to 6,700.00.

## What Was True

No money was stranded. At 2026-10-14 23:33 UTC the stranded-ticket settlement
(migrations `20261012055242` to `20261012055452`) paid 928 entry-only direct
tickets worth 55,120.00, whose targets had closed before they could be used,
to their holders in cash through `fn_ca_pay_closed_target_ticket_in_cash`.
That door writes one `ticket_redeem` leg escrow to player wallet keyed
`ticket:<id>:closed-target-cash` and moves the ticket `issued -> redeemed`.
The trigger `zz_closed_target_pays_its_satellite_tickets` does the same live
whenever a target closes.

The `seat_income` term of `fn_tournament_conservation_delta` and
`fn_tournament_conservation_deltas` counted every redeemed ticket as money
arriving at its target. Before 2026-10-12 the only way to `redeemed` was
tournament admission, so that was true. The cash door reused the status, so
each cash-paid ticket credited a target it never entered.

Measured read-only on production: 57 targets carry cash-paid tickets (940
tickets, 57,520.00), and for all 57 the live delta equals the cash-paid value
to the penny. No other event moves. The satellites stay balanced.

`fn_pay_backed_payout_shortfalls` carries the same term inline and treats an
event with a positive delta as holding money it may pay a reconciler top-up
from. Through the misread every one of those 57 targets looked like it held its
cash-paid tickets' value. Its hourly job runs dry and raised nothing, so
nothing was paid from it; the term is corrected there too so it never can be.

## The Fix

Migration `20261015072547_a_ticket_paid_in_cash_never_arrived_at_its_target`
changes the one predicate in all three reads (scalar, one-pass set and the
backed-payout batch): a redeemed ticket is seat income
only when it has no `closed-target-cash` leg. It edits the live text in place
with the pinned-preimage substitution (live md5 in, derived postimage md5
out, owner, grants, SECURITY DEFINER and config unchanged). It writes no
alert, wallet or ledger row. After install the hourly pass re-reads every
open alert through the corrected scalar and closes the 56 itself.

## The Pin

`scripts/ci/test-ticket-cash-conservation.py` on native PostgreSQL, run by
`.github/workflows/ticket-cash-conservation.yml`: the exact production
definitions read a cash-paid ticket as retained money; after the migration
it reads as nothing arriving, an admitted ticket still arrives, an issued
ticket still does not, a real retention still flags, the satellite is
unchanged, set and scalar agree, the live scan closes only the false alert,
the batch dry run no longer counts the cash target as payable, and a second
run refuses. `tests/backedPayoutScanRegression.test.ts` lists the migration
as a reviewed dynamic patch and pins that all three calls swap the same
anchor from the Diamond postimages.
