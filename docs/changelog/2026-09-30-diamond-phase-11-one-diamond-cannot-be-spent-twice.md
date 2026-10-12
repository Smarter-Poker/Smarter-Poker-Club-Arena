# One Diamond Cannot Be Spent Twice (Diamond Phase 11, Line 2)

2026-09-30. Phase 11 line 2: "Test transfer/store/game concurrency, duplicate
delivery and crash recovery."

A new CI suite, `tests/sql/run-diamond-concurrency.py`, runs production's own
Diamond money doors in an isolated PostgreSQL 17 and does four things:

- races one player's Diamonds through every door that can spend them;
- delivers the same request twice to nine money doors;
- kills a session inside every door at every write;
- crashes the database in the middle of a workload and restarts it.

It found four defects that needed no owner decision. Three migrations fix them
in production. Each was rehearsed on the exact file and applied once.

## What changed

1. **A player can buy into a Diamond cash table.**
   `20260930121500_a_diamond_cash_buy_in_reaches_the_wallet`. Two guards
   refused every client buy-in:
   - the profile guard did not name the buy-in door that writes the wallet;
   - the arena structure guard counted a Diamond table's four generated columns
     as a structure change, because a BEFORE trigger sees them as NULL.

   Nobody had noticed because the cash switch is closed. The switch stays
   closed.

2. **A registration and a cash buy-in no longer deadlock.**
   `20260930123828_a_diamond_seat_takes_the_table_cap_before_the_wallet`. One
   player's Diamond registration and cash buy-in took the table-cap lock and
   the wallet in opposite orders. The registration now takes the table cap
   first, as the cash doors do.
3. **One lock order for every seat.**
   `20260930131333_every_seat_takes_the_table_cap_before_the_wallet`. The
   second migration covered Diamond events only. That turned one player's chip
   registration and Diamond registration into a new deadlocking pair. The same
   chip registration also deadlocked with a Diamond cash buy-in, a pair the cash
   switch had been hiding. Every seat, chip or Diamond, now takes the table cap
   before the wallet.

## What did not change

No table, column, grant or new function. Neither Diamond switch opens. No
Diamond moves, and no price changes.

## Evidence

- `docs/evidence/diamond-phase-11/concurrency-and-recovery.md`: every
  interleaving and its result.
- `tests/sql/run-diamond-concurrency.py`, with the capture, the tables and the
  seed it loads. It runs in the `Accounting transactions (PostgreSQL 17)` job
  through `scripts/ci/run-diamond-sql-acceptance.py`.
- The three rehearsal fixtures under `docs/evidence/diamond-phase-11/`.
- Three laws, one per migration: `tests/a-diamond-cash-buy-in-reaches-the-wallet.law.test.ts`,
  `tests/a-diamond-seat-takes-the-table-cap-before-the-wallet.law.test.ts` and
  `tests/every-seat-takes-the-table-cap-before-the-wallet.law.test.ts`.

## Open for Dan

1. **Should every door answer a replay with its first receipt, word for word?**
   Five doors do. The store purchase marks a replay as cost 0 and granted
   false. Unregistration adds replay markers. The rebuy core answers
   "idempotent", and the prize payer answers false. Each still takes effect
   exactly once.
2. **Should the prize payer refuse a reused key with a different amount by
   name?** Today it pays nothing and answers false. Every other door refuses
   that case by name.
