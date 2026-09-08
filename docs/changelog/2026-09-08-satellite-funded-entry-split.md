# Funded Entries And Shared Refund Accounting

A satellite-awarded bounty entry credited the full buy-in to prizes, then the seed trigger added a bounty on top. An 11-chip ticket (10 buy-in plus 1 fee, including 5 bounty) therefore created 16 chips of liabilities. The seat helper now uses the same entry split as paid registration, seeds the funded bounty directly, and records the exact split on the transfer and payout receipts. The atomic delivery checker verifies the resulting prize and bounty pools.

Both escrows are opened before the award writes, avoiding reconstruction from only part of the transaction. Versioned transfer metadata gives the escrow writer and reconstruction query the same prize/bounty/fee basis. Shared refund apportionment includes funded satellite entries. Unregistration fee reversals now have the same attribution-only treatment as cancellation reversals, so a refunded fee is not removed a second time. Unregistration timing and destination-wallet selection are unchanged. No separate satellite refund mechanism or historical balance rewrite is added.

Verification reproduced the duplicate bounty with the installed definitions. Sixteen real PostgreSQL scenarios cover ordinary, bounty, PKO and mystery targets, zero/nonzero fees, mixed cash/satellite funding, exact delivery, replay, refund fee reversal and escrow reconstruction. The existing isolated accounting suite also passes. The source guard now follows the shared database late-entry predicate rather than requiring its obsolete inline implementation.

The newer atomic satellite finish and recovery implementation already supersedes the old per-winner engine path. PR #3794 was closed because its minutes-only engine patch targeted that removed path; current exact delivery uses the database's shared predicate. PR #3791's cents fix remains merged, but the old TypeScript planner is no longer the economic authority.

This record does not certify the entire 216-requirement audit, historical entitlements, or deployed engine adoption. Database installation, source merge and live cutover require separate evidence.
