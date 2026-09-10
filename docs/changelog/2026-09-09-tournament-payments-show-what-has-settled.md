# Tournament Payments Show What Has Settled

Results previously exposed prize totals without showing whether the player's obligations had been paid. The player statement also had no view of unpaid tournament amounts.

A shared panel now reads the signed-in player's obligations through `fn_ca_my_tournament_payments`. Results filter it to the selected event; player statements retain their club filter. It distinguishes paid, partially paid, owed, and zero-due records, preserves cents, and labels satellite seat value as transferred. Missing records remain unconfirmed. Completion never establishes payment.

The authenticated RPC binds identity to `auth.uid()`, offers bounded keyset pagination, and grants no browser access to the underlying ledger table. The migration adds the supporting user-first index. It changes no obligation, wallet, journal or payout amount.

Verification: 26 affected client tests; five isolated PostgreSQL 17 scenario groups covering permissions, owner and view filters, tied-timestamp pagination, unchanged data, and index use. A browser fixture at 375px showed readable amounts, a working refresh control, no overflow and no runtime errors. The fixture uses synthetic responses; it does not certify a live player session or payout execution.

Database application: physical version `20260909235308`, independently checked at 2026-09-09 23:53:48 UTC. Browser deployment and final release evidence are recorded in the Phase 3 register. This correction does not complete Phase 3.
