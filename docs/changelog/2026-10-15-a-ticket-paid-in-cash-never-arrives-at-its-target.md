# A Ticket Paid In Cash Never Arrives At Its Target (2026-10-15)

## What happened

At 03:25 UTC the deep money-conservation pass (cron 274) raised 56 warnings at once: "Tournament retained money it never paid out", on 56 completed freezeout targets, 55,120.00 in all. Example: Sunday Funday Main Event (1c4e59cf, 2026-09-15) at +6,700.00.

## Cause

`fn_ca_pay_closed_target_ticket_in_cash` (20261012054804) pays an unused entry-only satellite ticket in cash once its target closes. It moves the value from the ticket escrow to the holder's wallet under the key `ticket:<id>:closed-target-cash`, and marks the ticket `redeemed`. On 2026-10-14 at 23:33:05 UTC the settlement migrations paid all 928 stranded tickets this way: 55,120.00 to 460 holders, once each. The money is right.

Both conservation readings (`fn_tournament_conservation_delta` and `fn_tournament_conservation_deltas`) count every `redeemed` ticket as a seat that arrived at its target. Before 2026-10-12 that was true, because redeeming meant entering. A ticket paid in cash is also `redeemed`, but nothing arrived. On the Sunday Funday target, 61 of the 67 redeemed tickets belong to holders who never entered it, and each one read as 100.00 the target collected and never paid out.

## Fix

Migration `20261015100003_a_ticket_paid_in_cash_never_arrives_at_its_target.sql` changes the arrival gate in both readings. A ticket whose redemption is the cash door's own leg is no longer counted as arriving; the leg is found by its unique idempotency key. The satellite side is unchanged, because the satellite did pay that seat out, into the escrow that paid the holder.

The migration:

- replaces exactly one gate per body;
- asserts the pre and post images;
- keeps owner, grants, config, security definer and volatility;
- writes no row or money.

## Proof

A self-aborting pg_temp trial in production:

- All 56 flagged targets read 0.00.
- The whole 45-day deep window flags nothing, so no other event's reading moves.

The next hourly pass (cron 144) resolves the 56 open alerts through its own pass 1. Pinned by `tests/a-ticket-paid-in-cash-never-arrives-at-its-target.law.test.ts`.
