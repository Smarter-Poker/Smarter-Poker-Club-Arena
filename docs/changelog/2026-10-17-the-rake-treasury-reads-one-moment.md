# The Rake Treasury Reads One Moment, On The Cashier Desk

**Date:** 2026-10-17
**Found by:** Dan's sweep ("check for any and all bugs, gaps, stubs, errors, regressions or wiring issues")

## The Drift Was Not Money

Midway Union's Rake Treasury detail read as a multi-million drift between the rake wallet and its ledger. One production snapshot at 03:58 UTC: the wallet held 2,849,954.40 and its 3,665,867 ledger legs net to exactly 2,849,954.40. Drift 0.00.

The panel compared two moments: the live wallet against `union_rake_ledger_checkpoint`, which `fn_union_rake_ledger_summary` returns alone and which had not advanced since 22:17 (28,556 legs behind). Every chip raked since the checkpoint showed as drift.

`20261017040354_the_rake_treasury_reads_wallet_and_ledger_in_one_moment.sql` adds `fn_union_rake_ledger_reconciliation(uuid)`: checkpoint plus its tail plus the wallet, in one statement, drift computed in SQL. Read-only, same caller gate. The World Hub route moves to it in its own pull request once this is installed.

## The Last Generic Treasury Modal

`UnionTreasuryDetailModal` (Rake Treasury, Jackpot Banks, Backup Jackpot) was the last union wallet still drawn as a rounded inline-styled card of tables. It now opens on `WalletDesk`, portaled to the page body like the other desks: desk rows for every figure, the Cashier's Close, the painted dock with Max / Move Funds for the backup transfer and Send Out where the host offers it. Loading, the transfer guards, Escape and every figure are unchanged; Escape and Close now hold while a transfer is in flight.

Pinned by `tests/components/unionTreasuryDesk.test.tsx`.
