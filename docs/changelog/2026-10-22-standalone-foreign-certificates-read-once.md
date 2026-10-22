# Standalone weekly close reads foreign Union certificates once

Deep Stack Society's standalone book for the week of 2026-10-12 could not close. Every native visit timed out while holding the book and a direct 24-minute attempt did not finish, although the Union had already paid every obligation for the week and the standalone book owed nothing.

The cause was the exclusion added by 20261021173708. It tested each exact-week period's Union certificate one period at a time, and each test re-read `accounting_payable_earning_sources` for the source count, for every allocation and for the standalone-source check. With 416 Deep periods, one source count alone took about 1.5 seconds and three periods took longer than two minutes.

Migration 20261022025039 adds `fn_standalone_foreign_certificate_periods`, which evaluates the identical tests as one set over the standalone club's week of sources, and swaps only the three selection anchors (two in the stage, one in the plan) to use it. Measured read-only on production: all 416 periods excluded in 39 seconds.

Every original refusal is preserved. The isolated PostgreSQL qualification (`scripts/ci/test-historical-rakeback-payers-postgres.py`) now installs the migration after its predecessor, proves both owner bodies reverse byte-for-byte to the predecessor outside the anchors, and runs all nine refusal cases and the zero standalone close on the set form. The migration writes no payment, wallet, ledger, receipt or invoice row.
