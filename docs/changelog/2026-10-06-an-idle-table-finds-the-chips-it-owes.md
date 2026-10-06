# An idle table finds the chips it owes (2026-10-06)

## What was wrong

A browser rebuy (`atomic_table_rebuy`) debits the wallet and writes a
`table_pending_addons` row; the engine's `processPendingAddOns` delivers it to
the felt or refunds what does not fit. The engine reads that ledger only when
its sweep flag is up, and for a row written from outside the process the flag
was raised only by questions asked about BROKE seats. A row for a seat that
still had chips was found at the next hand commit, and a table that is not
dealing has none.

Production: `table_pending_addons` 8ba60255 (2026-09-03), rebuy 400, created
20:24:31, resolved 21:00:10 on the first pass after the hourly restart: 36
minutes with the wallet debited and nothing on the felt. Row 1db997d6
(2026-10-04) waited 73 seconds at a dealing table for the same reason.

## The fix, at the cause

`ServerTableEngineBase.findLedgerChipsOwedWhileWaiting()`: the wait loop,
where a table that is not dealing lives, asks the ledger about its seated
roster on each pass (one indexed read, skipped when a sweep is already
requested). A hit raises the flag and `processPendingAddOns`, called on the
next line, delivers or refunds in the same pass. Nothing is scheduled; it is
the loop the table is already running.

## What is not in this change

Why the 2026-10-04 player was shown a rebuy prompt while holding a full stack
is still unconfirmed; the audit's suspected trigger (the prompt reading a
not-yet-reported stack as zero) has not been reproduced, and no change is
shipped on a guess. With this change the excess of such a rebuy comes back
within one wait-loop pass at an idle table instead of at the next restart.

## Proof

`server/src/engine/AnIdleTableFindsTheChipsItOwes.test.ts`.
