# The house does not dun itself (2026-10-02)

Launch-gate sweep. Migration `20261002165500`. `fn_ca_midway_burnin_gate` has never passed (744 runs since 2026-08-31). Two of its standing reds:

## Four square-ups the house owes itself

Club JAQK, SHARK CLUB and Midway Union have one owner (the house account). The weekly square-up is an off-ledger statement, so between one owner's own books no payment can ever be recorded against it. Four sat unpaid:

| Statement | Club | Owed | Week |
| --- | --- | ---: | --- |
| MIDWAY-2026-000005 | Club JAQK | 33,222.29 | 09-07 .. 09-14 |
| MIDWAY-2026-000006 | SHARK CLUB | 11,242.82 | 09-07 .. 09-14 |
| MIDWAY-2026-000008 | Club JAQK | 42,719.62 | 09-21 .. 09-28 |
| MIDWAY-2026-000010 | SHARK CLUB | 35,117.39 | 09-21 .. 09-28 |

The first two aged past grace on 09-24 and suspended both clubs on 09-26 (four critical incidents). The last two were issued on 10-01 already past due and would suspend them again on 10-08.

Owner decision (Dan, 2026-10-02: "you decide ... it doesn't matter as long as the bug / glitch is fixed"). Marking them paid would record a payment that never happened, so the union waives each in full with a credit note (no message to the club). No chip moves. The hourly union sweep then finds nothing past due and restores both clubs.

## The push-deliverability light could not clear for the owner

The only active incident recipient is the owner, and since `20260916111614` his financial incidents are routed to the Production Alerts inbox and never pushed. The 48 h push-receipt check therefore raised its "unknown" warning every day by design. A routed recipient now counts as live when the inbox received an owner-operational row in 48 h (the daily estate digest guarantees one); everyone else still needs a fresh push receipt.

Dry run in production (rolled back): four credit notes, all four statements at 0.00 outstanding, zero stale recipients.
