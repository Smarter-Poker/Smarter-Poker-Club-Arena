# 2026-09-07 - One payment is one payout row, and this one was mine

Found while checking whether the 35 overfilled heads-up events conserved.
Tournament `3e281f5c`, a three-entry sit-and-go with a 71.25 pool, held FOUR
payout rows totalling 142.50 - exactly twice the pool. All four were written in
the same instant, and two carry
`metadata->>'migration' = '20260906153943_the_suspended_heads_up_is_settled_by_a_chip_proportional_dea'`.

That migration is mine, from earlier the same day. It credited the two players
through `fn_credit_and_log` - the platform's own idempotent path - **and**
recorded the payout itself, not knowing that the credit path records it too.

## Nobody was paid twice, and the ledger is what says so

`chip_ledger` for that tournament holds exactly three rows after 15:00: 47.50
and 23.75 `prize_liability -> player_wallet`, and 3.75 to the union rake
wallet. 75.00, which is 3 entries x 25.00, conserving to the cent. The money
moved once. **The record said it moved twice**, and `tournament_payouts` is
what a conservation query sums - it is exactly what I summed an hour before -
so the event read as a 71.25 overpay to anyone who would ever look.

## What was done (20260906233733)

The table refused the first attempt, and it was right to:
`trg_tournament_payouts_append_only` raised _"tournament_payouts is an
append-only payout record; DELETE is refused"_ and its own HINT states how a
correction is meant to be made - `SET LOCAL app.payout_record_correction`,
postgres only, from a migration that says why. This is that migration.

- the two rows my migration wrote are removed, and the removal is filed in
  `ca_drift_incidents` with the ids, amounts, players, the rows that stand and
  the ledger evidence, so nothing is erased quietly;
- two older rows from `agent_reconciliation` carried no idempotency key either.
  They are NOT duplicates - each is the only row for its payment - so they are
  keyed, not removed;
- the cause is closed at the write: `uq_tournament_payouts_idempotency_key` is
  partial (`WHERE idempotency_key IS NOT NULL`), so an unkeyed row was exempt
  from the one thing that stops a payment being recorded twice. A row now
  DERIVES a key when its writer supplies none. It never refuses - a guard that
  can refuse a payout row could leave a credited player with no record, which
  is the wrong failure (11.5).

`tests/one-payment-is-one-payout-row.law.test.ts` pins the repo half, which no
trigger can see: a migration that credits through the platform's path may not
also hand-write the payout row.

Applied at 00:02:58, after a first attempt deadlocked (40P01) by correcting
rows and then taking ACCESS EXCLUSIVE for the trigger. It takes the table lock
up front now, so it can only wait, never deadlock.
