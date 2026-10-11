# The Diamond Arena statement reconciles each journal row against all of its legs

2026-10-11. Migration `20261011192722`.

## What players saw

The Diamond Arena Statement on the wallet's Ledger tab told 379 of the 418
players who have ever used the arena that lines of their statement "Do Not
Reconcile": 3,791 lines in total, read on production at 19:30 UTC.

## What was true

Not one diamond was wrong. Every wallet balance equals its journal (0 drift),
and every journal row equals the signed sum of the custody legs that point at
it (7,209 journal rows checked, 0 mismatches).

## The cause

`fn_diamond_arena_reconciliation` compared each custody leg with its journal
row one-to-one. Since `20261007132503` a journal row records only what moved
the wallet, and two lanes write one row for several legs:

- A tournament prize: one `arena_withdraw` row to the winner is paid from every
  entrant's custody. Each entrant's leg (14) was compared with the whole prize
  row (204), so every entrant was told a correct payout, which was not even
  theirs, did not reconcile. 3,446 lines.
- A satellite seat: a prize-bank reserve and a custody-to-custody release net to
  one zero-amount row. 345 lines.

## The fix

The function now compares each journal row the player's legs point at with the
signed sum of every non-house leg pointing at it, whoever owns the custody.
House legs stay excluded as `20261007132503` decided. The reasons the client
words (`journal_missing`, `reserve_amount_mismatch`, `release_amount_mismatch`,
`release_movement_missing`, `seat_stack_drift`) are unchanged, so the client
needs no change. A partial index on `poker_diamond_movements(wallet_journal_id)`
makes the "every leg of this row" lookup cheap.

## Proof

A rolled-back probe ran the new body for all 418 arena users on production:
0 unmatched lines, 0 unbalanced players, and a stranger is still refused with
`arena_reconciliation_is_own_only`.

Pinned by `tests/the-diamond-arena-reconciles.law.test.ts` ("the statement
reconciles each journal row against ALL of its legs").
