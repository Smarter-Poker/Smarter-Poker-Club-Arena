# The Payout Sweep Never Reads A Cash Paid Ticket As Pool Money (2026-10-15)

Migration `20261015170338_the_payout_sweep_never_reads_a_cash_paid_ticket_as_pool_mone.sql`.
Held draft; replaces PR #6928 (`20261015072547`), which its own preimage guard refused.

## What Happened

At 03:25 UTC the deep money-conservation pass raised 56 "Tournament retained
money it never paid out" warnings (55,120.00). The stranded-ticket settlement
of 2026-10-14 had paid 928 direct satellite tickets in cash because their
targets closed before the tickets could be used. The cash door moves a ticket
issued to redeemed, and the conservation reads counted every redeemed ticket
as a seat arriving at its target.

## What Was Already Fixed

PR #6941 (`20261015100003`, installed) corrected the scalar
`fn_tournament_conservation_delta` and the set read
`fn_tournament_conservation_deltas`. Read on production at 17:05 UTC: all 56
alerts closed at 13:12 UTC through the hourly pass, each delta had equalled its
target's cash-paid ticket value to the cent, and all 56 targets read 0.00.

## What This Fixes

`fn_pay_backed_payout_shortfalls` carries the same seat income term inline and
was left on the old gate. 46 targets inside its 30-day window read as holding
42,160.00 of cash-paid ticket value they never held. None reports a top-up
today, so nothing was paid and no alert was suppressed. The day one does, the
sweep would count the event as funded instead of raising its withheld alert,
and in apply mode would pay and then trip its own conservation refusal because
the corrected scalar disagrees. The migration installs the identical gate #6941
installed, so the payer, the scalar and the set read exclude a cash-paid ticket
by one rule. It refuses unless the scalar and set already carry that gate.

## Proof

`scripts/ci/test-ticket-cash-conservation-v2.py` (native PostgreSQL, workflow
`ticket-cash-conservation-v2.yml`) loads the exact production text of all three
functions and proves the payer now selects exactly the events the scalar reads
above 0.01, a real shortfall still pays, a short cash target is withheld rather
than paid from the ticket's value, and the postimage md5 matches the one
derived on production.
