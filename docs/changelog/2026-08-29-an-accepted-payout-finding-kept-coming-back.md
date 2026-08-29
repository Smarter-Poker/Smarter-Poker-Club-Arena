# 2026-08-29 — an accepted payout finding kept coming back

Found by watching the thing I had just fixed.

`fn_tournament_payout_reconcile` files a `critical` financial alert whenever it
cannot fully reconcile an event, and it already refuses to file a second one
while an alert for the same tournament is still **open**. Resolving the alert is
what breaks that guard.

The finding does not go away when somebody accepts it. An overpayment nobody is
clawing back is a permanent property of a COMPLETED event, so the next sweep
sees no open alert and files a fresh one. That gets resolved, and so on, every
thirty minutes, forever.

Watched live: 77 alerts closed at 12:41 under Dan's ruling to accept the
residual overpayments; by 13:07 the settler had re-filed **26 of them**, every
one reporting `total_top_up = 0` and nothing but `overpaid` and
`no_finisher_recorded`. Left alone that buries the next real shortfall inside a
day — which is precisely the failure the table exists to prevent, and precisely
how 11,238.80 of unpaid prize money stayed hidden until this morning.

**My own change earlier today made it worse, which is worth saying plainly.**
Fixing the sweep's window so it measures when an event _finished_ means the
deep pass now genuinely reaches old events. That is the fix working — and it
also means every historical accepted overpayment is re-examined twice a day
instead of never.

## The rule

An accepted finding is not re-filed, on three conditions, all required:

1. **Nothing is owed.** `total_top_up = 0`. A shortfall is the entire point of
   this table and alerts every time, whatever anybody accepted before.
2. **Every current issue is of a class a human can only accept** — `overpaid`
   (the reconciler deliberately never claws back) and `no_finisher_recorded`
   (the prize is owed to nobody identifiable). A `duplicate_finishers` finding
   is a live double-pay defect and still alerts, even on an event with an
   accepted history.
3. **A human actually accepted this event** — a resolved alert for it carrying
   a `resolution` key. Nothing is silenced that was not deliberately looked at.

Resolving still works exactly as before: close an alert without stamping a
resolution and it is filed again on the next sweep.

The migration carries its own assertion — it re-asks an event that was just
accepted and fails if a new alert appears. Verified on apply. Open payout
alerts: **0**, down from 26 and climbing.
