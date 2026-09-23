# tests/a-tournament-cannot-complete-owing-its-pools.law.test.ts

## The law

A non-satellite tournament cannot commit `COMPLETED` unless the atomic
terminal authority wrote its receipt, and that authority writes the receipt
only after paying the cash pool and the bounty pool to the cent in the same
transaction. The deferred constraint trigger
`non_satellite_completed_requires_terminal_receipt` is never dropped,
disabled or loosened.

## Why it is a law now

Two hourly pg_cron jobs paid tournament money after the fact:
`ca-payout-sweep-hourly` (`fn_tournament_payout_sweep(7, true, 150000)`) and
`ca-bounty-backpay-hourly` (`fn_backpay_unfinalised_bounty_pools(true, 200)`).
They existed because an event could reach COMPLETED with part of a pool
unpaid. 20260909014534 made that impossible at commit.

Measured 2026-09-22, read-only: the first receipt is 2026-09-09 22:01:30 and
every non-satellite completion since carries one; 0 of 184,031 COMPLETED
non-satellite events with a pool in the last 30 days paid less than it; 0 of
154 bounty events completed since the cutover hold an undistributed bounty
pool; the hourly sweep last paid on 2026-09-06 and the bounty backpay on
2026-09-03.

Retiring those jobs leaves this trigger as the only barrier between a player
and an unpaid pool, so it is pinned.

## Forward guard

Every migration after 20260909014534: the trigger is never dropped without
being recreated as a deferred constraint trigger on `UPDATE OF status`, never
disabled (by name, `ALL` or `USER`), and its function is never redefined
without its refusal.
