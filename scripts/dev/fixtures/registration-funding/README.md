# Pre-Start Registration Funding Rehearsal

Run `python3 scripts/dev/probe-tournament-registration-funding-pg17.py`. It creates and stops its own PostgreSQL 17 cluster over a private local socket and accepts no database URL. Set POKER_AUDIT_PG_BIN to an existing PostgreSQL 17 bin directory when Homebrew is unavailable. CI sets PGNODE to use its existing pinned pg 8.16.3 client, including transaction barriers, so no psql or createdb binary is required.

The runner uses the installed request receipt, registration wrappers, debit, club wallet, journal, immutable charge entitlement, wallet receipt, escrow, fee and roster functions. It reuses the recorded satellite-refund table/financial fixture and adds the current entry contract. The source manifest records catalog function hashes; no player data is captured.

The cases prove one funded entry, rollback after a late receipt failure, overlapping same-key and different-key requests, two contenders for the final place, a registration blocked behind pool closure, and a player with wallets at two clubs. Overlap is observed through PostgreSQL lock waits while the first real RPC transaction remains uncommitted. No deeper lock is acquired before invoking the RPC. The entry-receipt migration is also applied twice in the first isolated case to check its source precondition on replay.

`--cross-club --baseline` deliberately omits the correction and exits nonzero: an entry charges its tournament club from 500 to 300 but logs the older membership's 1,000 balance. The correction records 300. It changes no debit amount, wallet balance or historical receipt.

The default runner also includes the separate tournament-purchase-funding rehearsal. Its limits and source capture are documented in that fixture directory.

## Limits

Only ordinary pre-start entries at a standalone club are exercised. Auth identity/session liveness and maintenance state are synthetic. Membership management, RLS/HTTP, notification/reporting/VIP triggers, late-entry seating, union funding, promotional entries, re-entry, SNG launch and actual tournament pool finalization are outside this fixture. Closure is represented by a transaction committing the finalized field while a real registration waits on its row. The production ledger, entitlement and escrow writers for the tested route are retained, but this is not a full production-schema clone or closure of all T01/S01/S02 controls.
