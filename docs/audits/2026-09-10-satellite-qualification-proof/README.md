# Exact-K Satellite Qualification Proposal

This proposal stops a satellite at exactly K live players when its frozen funded pool is exactly K target entries with no remainder. The immutable boundary records the source cohort, positive stacks, physical seats, lease generation, and qualification time. The existing atomic satellite payer delivers seat, noncash ticket, or cash outcomes. Version-three receipts have no winner and qualifiers have no finishing position.

The proposal is local and is not production-ready while the separately owned final tournament seat-authority deployment is absent. Its source gate intentionally refuses the currently installed wrapper. No production SQL, engine restart, or push was performed by this lane.

## Native Verification

`native-cases.py` runs the actual installed functions on the owned PostgreSQL17 fixture. Its committed prelaunch seed precedes each launch transaction, then each test forces every deferred constraint and rolls back. Cash assertions read the actual club member balance authority. All 23 native cases pass. Three late-failure cases first call the unchanged original final receipt verifier and observe all three payouts plus the actual cash, target-entry, or ticket assets, then raise an error. They verify rollback restores club balances, source liability and physical seats while removing all destination entries, tickets, awards, receipts and qualifier rows. A separate early-header failure tests refusal before awards. Actual SET LOCAL ROLE service_role succeeds through engine entries; authenticated and anon cannot execute service or private entries, and service_role cannot bypass the private payer/verifier.

`lease-lock-race.py` proves a real target-row lock wait can outlive the initial lease check. The negative control accepts that expired owner; the final-write check refuses it. Both leave RUNNING with no boundary or payout after rollback. The corrected body is restored in a finally block.

Preparation now holds the lease row FOR KEY SHARE, matching the reviewed request fence. Its complete preparation path does not mutate or upgrade the lease. Actual claimant/heartbeat definitions, postgres ownership, private grants and fixed search_path are pinned by an additional source gate. Four observed liveness races prove the old FOR UPDATE control makes the actual heartbeat busy, the corrected lock permits renewal while a claimant waits, expiry refuses before takeover, and a changed generation refuses after the later target wait. Every race restores the complete source/destination/accounting snapshot. Six catalog cases verify exact prerequisites, missing/weakened/owner/service-grant refusals, and the existing guard's automatic repair of an attempted public grant.

`catalog` preserves the current definitions and exact trigger enable states used to repair the old full-schema fixture. Its explicit final-seat prerequisite is a local test dependency, never authorization to install Stage-B in production. Seven currently disabled live tournament guards remain disabled, including the financial-certificate guard. This is not full financial-certificate acceptance. The source escrow's initial 600-chip liability is a fixture setup; this suite does not claim to test its original purchase collection.

## Remaining Acceptance

The final seat-authority owner must deploy and verify its own prerequisite. The integration still needs the exact-K RUNNING-target physical assignment and process-level restart recovery flow, plus root publication and live verification. Threshold-crossing ties and remainder contracts remain tracked separately. The complete phase is not certified by this proposal.
