# BBJ Original Payout Pool

The contribution path resolves private-table, union and standalone destinations, but the engine payout path selected the club's current union/club pool. That could debit a different bank for a private table or after a membership change. A retired pool also became unreachable for replay even though it retained parked obligations.

The existing attemptBBJPayoutOnce path now looks up the hand's recorded payout first. Without a prior payout, it uses the hand's contribution receipt. Both lookups use table_id and hand_number and require a single readable record. A missing or ambiguous destination stays pending on the existing queue path; it never falls back to current club membership. First allocations require an active original pool. Replay can reach the original retired pool. Main and Mini use this shared path; their existing payout RPCs are unchanged.

## Verification

Nine actual-module routing tests failed against the original source. All nine pass after correction, including Main/Mini private routing, recorded-payout precedence after retirement/membership change, unreadable and ambiguous payout/contribution records, missing contributions, and retired first-allocation destinations. The 23 existing payout tests also pass.

Server TypeScript passed. Full suite: 6,813 passed and one existing queue-registration fixture failed because it lacked the newly required contribution record. The fixture was updated to supply that record while preserving its real-writer/transient-RPC-failure assertions; the final targeted rerun verifies it alongside both payout suites. No production financial mutation was performed.

Read-only production inspection confirmed indexes idx_bbj_contrib_table_hand_number and idx_bbj_payouts_table_hand support these lookup keys. There is no schema migration in this change.

## Remaining Boundaries

This repairs the engine's destination selection, not the entire database concurrency boundary. Pool status may change between read and payout RPC; concurrent legacy writers still need database-level hand destination fencing. First awards whose original pool has already retired remain pending for explicit funding resolution. Historical receipts in multiple pools are not guessed or rewritten. Contribution-less legacy awards and broader queue persistence guarantees remain separate work. Global announcement scope still derives from current club membership and needs matching destination scope. Applied payout amounts and identity also need further receipt validation.

Deployment through the canonical Hetzner pipeline is required before claiming runtime adoption. The full audit remains incomplete.
