# The journal window is a snapshot, not a clock

**Date:** 2026-09-10
**Migration:** `20260910065825_the_journal_window_is_a_snapshot_not_a_clock` (applied 06:58 UTC)
**Law:** `tests/the-journal-window-is-a-snapshot-not-a-clock.law.test.ts`
**Incidents:** `36f00e54` (-100.00, CRITICAL), `446fbe37` (+258.09, CRITICAL) - both false, resolved with cause

## What the board said

At 06:40 UTC `fn_ca_ledger_replay` filed two criticals: player `b83fa747`'s
wallet "moved 161.12 while the journal accounts for 261.12: -100.00
unexplained", and the felt "moved 25712.86 ... journal 25613.71: 99.15
unexplained".

## What the rows said

The player's twelve wallet movements since the previous reading are all
journaled, their `wallet_transactions.balance_after` chain is arithmetically
exact, and nothing debits 100. What the previous reading missed is a 100.00
cash buy-in at table `3571a3c5` whose `chip_ledger` leg is stamped
`09:34:39.617` and whose transaction committed after the reading taken at
`09:34:41.869`. That reading recorded 49,518.39 - the balance before the
debit. The next reading opened its window at 09:34:41 by `created_at`, so the
leg (09:34:39) was outside it, while the balance it moved was inside: one
leg, missed on both sides of one boundary, -100 on the wallet and +100 on the
felt. No chips moved wrongly.

## What changed

The reader windowed the journal by `created_at` - the clock at INSERT time
inside a transaction - and compared it against balances read under a snapshot,
which is commit order. Those cannot agree at a boundary. Now every reading
records `pg_current_snapshot()` from the statement that read the balances and
the journal, and the next reading counts a leg iff it was NOT visible in the
previous snapshot (`fn_ca_leg_accounts_since_snapshot`; `fn_ca_xid8` restores
a tuple's epoch so `pg_visible_in_snapshot` can judge it). `created_at` still
bounds the scan to fifteen minutes before the previous instant so the index
is used. The basis becomes `one-snapshot-v4`; every account rebaselines once
and only readings that hold a previous snapshot are judged - the replay's own
"a change of basis is not drift" rule.

The migration proves the helper against the very leg that fell through
before it resolves the two incidents.
