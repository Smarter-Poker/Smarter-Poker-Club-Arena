# Phase 4 of 8: the Diamond Arena reconciles

**Date:** 2026-09-14
**Branch:** `agent/cw-wallet2/feat/phase-4-the-diamond-arena-reconciles` (stacked on phase 3, PR #4613)

**The Diamond Arena is diamonds only. No chips, ever.** (Dan, 2026-09-13.)

## What was already true, read from the definitions

Conservation across a Diamond Arena session is enforced where the money moves,
one transaction each: `fn_poker_diamond_buyin` writes the journal
(`arena_deposit`, -amount), the custody row, the movement (`reserve`) and the
lot reservation together; the top-up path has the same shape; and
`fn_poker_diamond_release` refuses an active cash seat until the seat has left
with `stack = custody.balance`, then credits (`arena_withdraw`, +balance),
records the movement and releases the custody together, replaying the
immutable receipt on a repeated request. The movement table cannot hold a
reserve without its journal row (CHECK). The old recovery function is gone
(`recover_fns = 0`). Nothing here needed fixing; 10.11's order of work says so
before building anything.

## What did not exist: the statement

A player could not see that their sessions reconcile, and nothing asserted it
per player. `fn_diamond_arena_reconciliation` (migration `20260914103736`) is
that read - and only a read (STABLE, no writes, own-user only unless
service_role): sessions, buy-ins, cash-outs, diamonds in play, the settled
result (over released sessions only; an open session has no result yet), and
every line that does not reconcile, named by reason: `journal_missing`,
`reserve_amount_mismatch`, `release_amount_mismatch`,
`release_movement_missing`, `seat_stack_drift`. Proved on production with a
rolled-back fixture: two sessions (100 in / 150 out, and 80 in with its release
movement deliberately missing) read as 2 sessions, 180 in, 150 out, settled
-30, unmatched exactly the broken one with `release_movement_missing`.

The wallet's Ledger tab now carries **Diamond Arena Statement** beneath the
Chip Statement: three outcomes (reading / Unavailable + Retry / known), the
five figures, and either "Every Session Reconciles" or the unmatched lines in
the player's words ("A Finished Session Has No Cash-Out On Record"), with the
sentence that nothing has been taken and operations corrects the record at the
source. It re-reads on `BALANCE_UPDATED`.

## The law

`tests/the-diamond-arena-reconciles.law.test.ts` (registered in `docs/laws.d/`):
the release path stays settlement-gated and atomic in the migration that
defines it; no migration may define a custody recover / repair / sweep /
backfill / heal / catch-up that is not dropped (10.12 - a repair job is not
allowed to exist as a fix); the reconciliation read never writes and is
own-user only; every reason it can name has a player sentence; the wallet
shows the statement and never a balance it did not read.

## Verified

`tests/components/DiamondArenaStatement.test.tsx` (reading, failed + retry,
empty, balanced, unmatched lines, no chip); the law (4); `tsc`, eslint, copy
gates and route targets clean.
