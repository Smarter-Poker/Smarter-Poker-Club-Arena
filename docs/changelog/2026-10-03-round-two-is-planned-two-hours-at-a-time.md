# Round two is planned two hours at a time (2026-10-03)

## What happened

Round 2 reads the closed week's sources, their recorded commission tiers and every commission row of
every source, builds the payee plan and pays it in one transaction. Measured for one day of Midway's
week of 2026-09-21 (48.6k sources): read 3.6 s, commission rows 22.9 s, about 0.6 ms a source. The
week closing 2026-10-05 (about 1.75M sources projected) needs about 17 minutes at low load in that
one transaction, past the 5-minute cap on every close transaction.

## Fix

Migration `20261003141618_round_two_is_planned_two_hours_at_a_time`, only in a chunked close:

- `fn_settle_accounting_commission_window` runs the stage's own reads and tests over one two-hour
  window: every test is of one source or of one commission row of the window's instant, so the week
  passes exactly when every window does; the one test across sources (one agent and one role per
  club and user) is kept as each window's min and max.
- `fn_accounting_close_windows_pending`, called by the scheduler after a successful preparation,
  proves the missing windows (`fn_settle_accounting_commission_advance`, at least one per attempt,
  none started more than 120 s after the attempt began) and ends that attempt as a committed step.
- The paying attempt combines the windows (`fn_settle_accounting_commission_combine`) into exactly the
  nodes, edges, clubs, fingerprint and source count the stage's own reads build, refuses as it
  refuses, and pays unchanged from there. A contract only the original v3 path can read refuses
  (`routed_commission_window_needs_full_path`) instead of running v3 in one long transaction.

Outside a chunked close, or with any window missing, the stage reads the week as before.

## Proof (2026-10-03, Midway, week 2026-09-21..28)

The 84 windows were proved in three committed cron probes of at most 125 s (548,020 sources), and
combined in 5 s. Against what the single-transaction close paid on 2026-10-01: the fingerprint equals
the round-2 receipt's `source_fingerprint`; sources 548,020 = 548,020; 110 of 110 payee nodes equal
the `agent_commission_settlements` rows (amount and rows); 110 of 110 edges are present in
`chip_ledger` under their idempotency keys with identical amounts; own 332,024.42, direct 332,024.42
and downstream 170,515.10 equal the receipt (the stored receipt prints 170515.1; the current stage's
own full-week read gives 170515.10, as the combine does). The combined plan reports no unclassified
row, no ambiguous hierarchy and no disagreeing entitlement.
